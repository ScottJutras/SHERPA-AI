require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const bodyParser = require('body-parser');
const axios = require('axios');
const { parseExpenseMessage } = require('./utils/expenseParser');
const { getUserProfile } = require('./utils/googleSheets'); 
const {
    appendToUserSpreadsheet,
    getOrCreateUserSpreadsheet,
    fetchExpenseData,
    calculateExpenseAnalytics,
    setActiveJob,
    getActiveJob
} = require('./utils/googleSheets');
const { extractTextFromImage, handleReceiptImage } = require('./utils/visionService');
const { transcribeAudio } = require('./utils/transcriptionService'); // New function
const fs = require('fs');
const path = require('path');

const admin = require("firebase-admin");

if (!admin.apps.length) {
    const firebaseCredentialsBase64 = process.env.FIREBASE_CREDENTIALS_BASE64;
    if (!firebaseCredentialsBase64) {
        console.error("[ERROR] FIREBASE_CREDENTIALS_BASE64 is not set in environment variables.");
        process.exit(1);
    }
    try {
        const firebaseCredentials = JSON.parse(
            Buffer.from(firebaseCredentialsBase64, 'base64').toString('utf-8')
        );
        admin.initializeApp({
            credential: admin.credential.cert(firebaseCredentials),
        });
        console.log("[✅] Firebase Admin initialized successfully.");
    } catch (error) {
        console.error("[ERROR] Failed to initialize Firebase Admin:", error.message);
        process.exit(1);
    }
}

const db = admin.firestore();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const onboardingSteps = [
    "Can I get your name?",
    "Are you in Canada or USA? (Canada/USA)",
    "Which province or state are you in?",
    "What type of business do you have? (Sole Proprietorship, Corporation, Charity, Non-Profit, Other)",
    "What industry do you work in? (Construction, Real Estate, Retail, Freelancer, Other)",
    "Do you want to track personal expenses too? (Yes/No)",
    "Do you want to track mileage? (Yes/No)",
    "Do you want to track home office deductions? (Yes/No)",
    "What is your primary financial goal? (Save to pay off debts, Save to invest, Spend to lower tax bracket, Spend to invest)",
    "Would you like to add your yearly, monthly, weekly, or bi-weekly bills to track? (Yes/No)"
];

const userOnboardingState = {};

app.post('/webhook', async (req, res) => { 
    const from = req.body.From;
    const body = req.body.Body?.trim();
    const mediaUrl = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0;

    if (!from) {
        return res.status(400).send("Bad Request: Missing 'From'.");
    }

    let userProfile;
    try {
        userProfile = await getUserProfile(from);
    } catch (error) {
        console.error("[ERROR] Failed to fetch user profile:", error);
        return res.send(`<Response><Message>⚠️ Sorry, something went wrong. Please try again.</Message></Response>`);
    }

    // ✅ Onboarding Flow
    if (!userProfile) {
        if (!userOnboardingState[from]) {
            userOnboardingState[from] = { step: 0, responses: {} };
        }
        const state = userOnboardingState[from];

        if (state.step < onboardingSteps.length) {
            if (state.step > 0) {
                state.responses[`step_${state.step - 1}`] = body;
            }
            const nextStep = onboardingSteps[state.step];
            state.step++;
            return res.send(`<Response><Message>${nextStep}</Message></Response>`);
        } else {
            state.responses[`step_${state.step - 1}`] = body;
            try{
            // ✅ Save completed onboarding profile
            userProfile = {
                user_id: from,
                name: state.responses.step_0,
                country: state.responses.step_1,
                province: state.responses.step_2,
                business_type: state.responses.step_3,
                industry: state.responses.step_4,
                personal_expenses_enabled: state.responses.step_5.toLowerCase() === "yes",
                track_mileage: state.responses.step_6.toLowerCase() === "yes",
                track_home_office: state.responses.step_7.toLowerCase() === "yes",
                financial_goals: state.responses.step_8,
                add_bills: state.responses.step_9?.toLowerCase() === "yes",
                created_at: new Date().toISOString()
            };

            await saveUserProfile(userProfile);
            delete userOnboardingState[from];
            return res.send(`<Response><Message>✅ Onboarding complete, ${userProfile.name}! You can now start logging expenses.</Message></Response>`);
        } catch (error) {
            console.error("[ERROR] Failed to save user profile:", error);
            return res.send(`<Response><Message>⚠️ Sorry, something went wrong while saving your profile. Please try again later.</Message></Response>`);
        }
    }
}
 // ✅ Non-Onboarding Flow for Returning Users
 let reply;
 try {
            if (mediaUrl && mediaType?.includes("audio")) {
                // 🎤 Voice Note Handling
                const audioResponse = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
                const audioBuffer = Buffer.from(audioResponse.data, 'binary');
                const transcription = await transcribeAudio(audioBuffer);
                reply = transcription ? `🎤 Transcription: "${transcription}"` : "⚠️ Sorry, I couldn't understand the voice note.";
            } else if (mediaUrl && mediaType?.includes("image")) {
                // 🧾 Receipt Image Handling
                reply = await handleReceiptImage(from, mediaUrl);
            } else if (body.toLowerCase().startsWith("start job ")) {
                // 🏗️ Job Tracking Feature 
                const jobName = body.slice(10).trim();
                await setActiveJob(from, jobName);
                reply = `✅ Job '${jobName}' is now active. All expenses will be assigned to this job.`;
            } else if (body.toLowerCase().startsWith("expense summary")) {
                // 📊 Fetch Expense Analytics  
                const activeJob = await getActiveJob(from) || "Uncategorized";
                const expenseData = await fetchExpenseData(from, activeJob);
                const analytics = calculateExpenseAnalytics(expenseData);

                reply = `
📊 *Expense Summary for ${activeJob}* 📊
💰 Total Spent: ${analytics.totalSpent}
🏪 Top Store: ${analytics.topStore}
📌 Biggest Purchase: ${analytics.biggestPurchase}
🔄 Most Frequent Expense: ${analytics.mostFrequentItem}
                `;
            } else {
                // 💬 Expense Logging via Text Message
                const activeJob = await getActiveJob(from) || "Uncategorized";
                const expenseData = parseExpenseMessage(body);
                if (expenseData) {
                    await appendToUserSpreadsheet(from, [
                        expenseData.date,
                        expenseData.item,
                        expenseData.amount,
                        expenseData.store,
                        activeJob
                    ]);
                    reply = `✅ Expense logged: ${expenseData.item} for ${expenseData.amount} at ${expenseData.store} on ${expenseData.date}`;
                } else {
                    reply = "⚠️ Could not understand your request. Please provide a valid expense message.";
                }
            }
        } catch (error) {
            console.error("[ERROR]", error);
            reply = "⚠️ Sorry, something went wrong. Please try again later.";
        }

        res.send(`<Response><Message>${reply}</Message></Response>`);
    });

// ✅ Debugging: Log Environment Variables
console.log("[DEBUG] Checking environment variables...");
console.log("[DEBUG] GOOGLE_CREDENTIALS_BASE64:", process.env.GOOGLE_CREDENTIALS_BASE64 ? "Loaded" : "Missing");
console.log("[DEBUG] FIREBASE_CREDENTIALS_BASE64:", process.env.FIREBASE_CREDENTIALS_BASE64 ? "Loaded" : "Missing");
console.log("[DEBUG] OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "Loaded" : "Missing");

// ✅ Load Google Vision Credentials from ENV
const googleVisionBase64 = process.env.GOOGLE_VISION_CREDENTIALS_BASE64;

if (!googleVisionBase64) {
    throw new Error("[ERROR] Missing GOOGLE_VISION_CREDENTIALS_BASE64 in environment variables.");
}

// ✅ Decode Base64 and write it to a temporary file in /tmp (since /var/task is read-only in Vercel)
const visionCredentialsPath = "/tmp/google-vision-key.json";
fs.writeFileSync(visionCredentialsPath, Buffer.from(googleVisionBase64, 'base64'));

// ✅ Set GOOGLE_APPLICATION_CREDENTIALS dynamically for Vision API
process.env.GOOGLE_APPLICATION_CREDENTIALS = visionCredentialsPath;
console.log("[DEBUG] Google Vision Application Credentials set successfully.");

// ✅ Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const environment = process.env.NODE_ENV || 'development';
console.log(`[DEBUG] Environment: ${environment}`);

// ✅ Function to get job-based expense summary
async function getJobExpenseSummary(from, jobName) {
    try {
        console.log(`[DEBUG] Fetching expense summary for job: ${jobName}, user: ${from}`);

        const expenseData = await fetchExpenseData(from, jobName);
        console.log(`[DEBUG] Retrieved expense data:`, JSON.stringify(expenseData, null, 2));

        if (!expenseData.length) {
            return `⚠️ No expenses found for job: ${jobName}`;
        }

        const analytics = calculateExpenseAnalytics(expenseData);
        return `
📊 *Expense Summary for ${jobName}* 📊
💰 Total Spent: ${analytics.totalSpent}
🏪 Top Store: ${analytics.topStore}
📌 Biggest Purchase: ${analytics.biggestPurchase}
🔄 Most Frequent Expense: ${analytics.mostFrequentItem}
        `;
    } catch (error) {
        console.error('[ERROR] Failed to fetch job expense summary:', error.message);
        return `⚠️ Unable to generate expense summary for ${jobName}. Please try again later.`;
    }
}

// ✅ Webhook Route Handling (Voice Notes, Images, and Messages)
app.post('/webhook', async (req, res) => {
    console.log("[DEBUG] Incoming Webhook Request", JSON.stringify(req.body));

    const from = req.body.From;
    const body = req.body.Body?.trim().toLowerCase();
    const mediaUrl = req.body.MediaUrl0; // WhatsApp image/audio URL
    const mediaType = req.body.MediaContentType0; // Detect audio/image type

    if (!from) {
        console.error("[ERROR] Webhook request missing 'From'.");
        return res.status(400).send("Bad Request: Missing 'From'.");
    }

    console.log(`[DEBUG] Incoming message from ${from}: "${body || "(Media received)"}"`);

    let reply;
    
    try {
        if (mediaUrl && mediaType?.includes("audio")) {
            // 🎤 Voice note received - process transcription
            try {
                console.log(`[DEBUG] Downloading audio file from ${mediaUrl}`);

                // ✅ Twilio authentication for fetching audio
                const audioResponse = await axios.get(mediaUrl, {
                    responseType: 'arraybuffer',
                    auth: {
                        username: process.env.TWILIO_ACCOUNT_SID,
                        password: process.env.TWILIO_AUTH_TOKEN
                    }
                });

                const audioBuffer = Buffer.from(audioResponse.data, 'binary');
                console.log(`[DEBUG] Audio file downloaded, size: ${audioBuffer.length} bytes`);

                // ✅ Transcribe the voice note
                const transcription = await transcribeAudio(audioBuffer);

                if (transcription) {
                    console.log(`[DEBUG] Transcription successful: "${transcription}"`);

                    // ✅ Check if transcription contains "start job [job name]"
                    const jobMatch = transcription.match(/start job (.+)/i);

                    if (jobMatch) {
                        // ✅ Start a new job if detected
                        const newJob = jobMatch[1].trim();
                        await setActiveJob(from, newJob);

                        reply = `✅ New job '${newJob}' started. You can now log expenses under this job.`;
                    } else {
                        // ✅ Log transcription as an expense under active job
                        const activeJob = await getActiveJob(from) || "Uncategorized";

                        await appendToUserSpreadsheet(
                            from,
                            [new Date().toISOString(), "Voice Note", transcription, "N/A", activeJob]
                        );

                        reply = `✅ Transcription logged under '${activeJob}': "${transcription}"`;
                    }
                } else {
                    reply = "⚠️ Sorry, I couldn't understand the voice note.";
                }
            } catch (error) {
                console.error(`[ERROR] Failed to process voice note:`, error);
                reply = "⚠️ Failed to transcribe voice note. Please try again.";
            }
        } 
        else if (mediaUrl && mediaType?.includes("image")) {
            // 🧾 Receipt image received - process image OCR
            reply = await handleReceiptImage(from, mediaUrl);
        } 
        else if (body.startsWith("start job ")) {
            // 🏗️ Handle job start request
            reply = await handleStartJob(from, body);
        } 
        else {
            // 💬 Normal text message (expense logging)
            try {
                const activeJob = await getActiveJob(from) || "Uncategorized";
                const expenseData = parseExpenseMessage(body);

                if (expenseData) {
                    await appendToUserSpreadsheet(
                        from,
                        [expenseData.date, expenseData.item, expenseData.amount, expenseData.store, activeJob]
                    );
                    reply = `✅ Expense logged under '${activeJob}': ${expenseData.item} for ${expenseData.amount} at ${expenseData.store} on ${expenseData.date}`;
                } else {
                    reply = "⚠️ Could not understand your request. Please provide a valid expense message.";
                }
            } catch (error) {
                console.error(`[ERROR] Failed to process text message:`, error);
                reply = "⚠️ Something went wrong while processing your message.";
            }
        }
    } catch (error) {
        console.error(`[ERROR] Error handling message from ${from}:`, error);
        reply = "⚠️ Sorry, something went wrong. Please try again later.";
    }

    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Message>${reply}</Message></Response>`);
    console.log(`[DEBUG] Reply sent: "${reply}"`);
});
// ✅ Function to handle setting a new job
async function handleStartJob(from, body) {
    const jobMatch = body.match(/start job (.+)/i);
    if (!jobMatch) return "⚠️ Please specify a job name. Example: 'Start job 75 Hampton Crt'";

    const jobName = jobMatch[1].trim();
    await setActiveJob(from, jobName);
    
    return `✅ Job '${jobName}' is now active. All expenses will be assigned to this job.`;
}
// ✅ Function to get response from ChatGPT
async function getChatGPTResponse(prompt) {
    try {
        console.log(`[DEBUG] ChatGPT Request: "${prompt}"`);
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: 'You are a helpful assistant.' },
                { role: 'user', content: prompt },
            ],
            max_tokens: 100,
            temperature: 0.7,
        });

        return response.choices?.[0]?.message?.content?.trim() || "Sorry, I didn't understand that.";
    } catch (error) {
        console.error(`[ERROR] OpenAI API call failed: ${error.message}`);
        return "❌ Failed to get a response. Please try again.";
    }
}
// ✅ Handle GET requests to verify the server is running
app.get('/', (req, res) => {
    console.log("[DEBUG] GET request received at root URL.");
    res.send("Webhook server is up and running!");
});

// ✅ Start the Express server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`[DEBUG] Webhook server running at http://localhost:${PORT}`);
});

module.exports = app;
