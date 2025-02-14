require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const bodyParser = require('body-parser');
const axios = require('axios');
const areaCodeMap = require('./utils/areaCodes'); // Adjust the path if necessary
const { parseExpenseMessage } = require('./utils/expenseParser'); 
const {
    getUserProfile,
    saveUserProfile,
    appendToUserSpreadsheet,
    getOrCreateUserSpreadsheet,
    fetchExpenseData,
    calculateExpenseAnalytics,
    setActiveJob,
    getActiveJob
} = require("./utils/googleSheets");

const { extractTextFromImage, handleReceiptImage } = require('./utils/visionService');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { calculateIncomeGoal } = require('./utils/googleSheets');
const { transcribeAudio } = require('./utils/transcriptionService'); // New function
const fs = require('fs');
const path = require('path');
const admin = require("firebase-admin");

// ─── FIREBASE ADMIN SETUP ────────────────────────────────────────────
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



function detectCountryAndRegion(phoneNumber) {
    if (!phoneNumber.startsWith("+")) {
        phoneNumber = `+${phoneNumber}`;  // Normalize phone number
    }

    const phoneInfo = parsePhoneNumberFromString(phoneNumber);
    if (!phoneInfo || !phoneInfo.isValid()) {
        return { country: "Unknown", region: "Unknown" };
    }

    const country = phoneInfo.country;  // ISO country code (e.g., 'US', 'CA')
    const nationalNumber = phoneInfo.nationalNumber; 
    const areaCode = nationalNumber.substring(0, 3);

    let region = "Unknown";

    if (country === 'US') {
        const usAreaCodes = {
            "212": "New York", "213": "Los Angeles", "305": "Miami",
            // Add all US area codes here
        };
        region = usAreaCodes[areaCode] || "Unknown State";
    } else if (country === 'CA') {
        const caAreaCodes = {
            "416": "Toronto, Ontario", "604": "Vancouver, British Columbia",
            // Add all Canadian area codes here
        };
        region = caAreaCodes[areaCode] || "Unknown Province";
    }

    return { country, region };
}

// ─── EXPRESS APP SETUP ───────────────────────────────────────────────
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ─── ONBOARDING STEPS ───────────────────────────────────────────────
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
    "Would you like to add your yearly, monthly, weekly, or bi-weekly bills to track? (Yes/No)",
    "Can I get your email address?"
];

const userOnboardingState = {};
// ✅ Function to send interactive WhatsApp Quick Replies
const sendQuickReply = async (from, text, buttons) => {
    try {
        console.log(`[DEBUG] Attempting to send Quick Reply to ${from}`);

        const buttonOptions = buttons.map(label => ({
            type: "reply",
            reply: {
                id: label.toLowerCase(),
                title: label
            }
        }));

        const response = await axios.post(
            `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, 
            new URLSearchParams({
                From: process.env.TWILIO_WHATSAPP_NUMBER,
                To: from,
                MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
                Body: text,
                "PersistentAction": buttons.map(b => `reply?text=${b}`).join(',')
            }).toString(), 
            {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                auth: {
                    username: process.env.TWILIO_ACCOUNT_SID,
                    password: process.env.TWILIO_AUTH_TOKEN
                }
            }
        );

        console.log(`[✅ SUCCESS] Twilio API Response:`, response.data);

    } catch (error) {
        console.error("[❌ ERROR] Failed to send Quick Reply:", error.response?.data || error.message);
    }
};
// ─── WEBHOOK HANDLER ───────────────────────────────────────────────
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
            const detectedLocation = detectCountryAndRegion(from);  // Use this function
            userOnboardingState[from] = { step: 0, responses: {}, detectedLocation };
        }
        const state = userOnboardingState[from];

        if (state.step < onboardingSteps.length) {
            if (state.step > 0) {
                state.responses[`step_${state.step - 1}`] = body;
            }

            // Skip country/province questions if detected
            if (state.step === 1 && state.detectedLocation.country !== 'Unknown') {
                state.responses['country'] = state.detectedLocation.country;
                state.responses['province'] = state.detectedLocation.region;
                state.step += 2;  // Skip country and province questions
            } 

            const nextStep = onboardingSteps[state.step];
            state.step++;
            return res.send(`<Response><Message>${nextStep}</Message></Response>`);
        } else {
            state.responses[`step_${state.step - 1}`] = body;
            
            // ✅ Email Validation (for step 10)
    const email = state.responses.step_10;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email)) {
        return res.send(`<Response><Message>⚠️ The email address you provided doesn't seem valid. Please enter a valid email address.</Message></Response>`);
    }
            try{
            // ✅ Save completed onboarding profile
            userProfile = {
                user_id: from,
                name: state.responses.step_0,  
                country: state.responses.country || state.responses.step_1,  // Use detected country or user input
                province: state.responses.province || state.responses.step_2, // Use detected province or user input
                business_type: state.responses.step_3,
                industry: state.responses.step_4,
                personal_expenses_enabled: state.responses.step_5.toLowerCase() === "yes",
                track_mileage: state.responses.step_6.toLowerCase() === "yes",
                track_home_office: state.responses.step_7.toLowerCase() === "yes",
                financial_goals: state.responses.step_8,
                add_bills: state.responses.step_9?.toLowerCase() === "yes",
                email: state.responses.step_10,
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
    if (body?.toLowerCase() === 'yes' && userOnboardingState[from]?.pendingExpense) {
        // ✅ User confirmed the parsed expense
        const confirmedExpense = userOnboardingState[from].pendingExpense;
        const activeJob = await getActiveJob(from) || "Uncategorized";
    
        if (!confirmedExpense.amount || !confirmedExpense.item || !confirmedExpense.store) {
            console.log("[❌ ERROR] Missing essential expense data. Aborting log.");
            return res.send(`<Response><Message>⚠️ Sorry, I couldn't process that expense. Please provide the full details.</Message></Response>`);
        }
    
        await appendToUserSpreadsheet(from, [
            confirmedExpense.date,
            confirmedExpense.item,
            confirmedExpense.amount,
            confirmedExpense.store,
            activeJob
        ]);
        delete userOnboardingState[from].pendingExpense;
        return res.send(`<Response><Message>✅ Expense confirmed and logged: ${confirmedExpense.item} for ${confirmedExpense.amount} at ${confirmedExpense.store} on ${confirmedExpense.date}</Message></Response>`);
    }
    // 🎤 Voice Note Handling   
    if (mediaUrl && mediaType?.includes("audio")) {
        const authHeader = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    
        const audioResponse = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            headers: {
                Authorization: `Basic ${authHeader}`
            }
        });
    
        const audioBuffer = Buffer.from(audioResponse.data, 'binary');
        const transcription = await transcribeAudio(audioBuffer);
        
        if (transcription) {
            console.log(`[DEBUG] Transcription Result: "${transcription}"`);
    
            // First try parsing with the existing regex logic
            const expenseData = parseExpenseMessage(transcription);
    
            if (expenseData) {
                // ✅ Send confirmation message to user
                await sendQuickReply(from, 
                    `Did you mean: ${expenseData.amount} for ${expenseData.item} from ${expenseData.store} on ${expenseData.date}?`, 
                    ["Yes", "Edit", "Cancel"]
                );
                return res.send(`<Response><Message>✅ Quick Reply Sent. Please respond.</Message></Response>`);
                
    
                // Store the pending confirmation in memory (or DB if needed)
                userOnboardingState[from] = { pendingExpense: expenseData };
            } else {
                // If parsing fails, fallback to GPT-3.5 immediately
                console.log("[DEBUG] Regex parsing failed, using GPT-3.5 for fallback...");
    
                const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                const gptResponse = await openai.chat.completions.create({
                    model: "gpt-3.5-turbo",
                    messages: [
                        {
                            role: "system",
                            content: "You are an assistant that extracts structured expense data from messages."
                        },
                        {
                            role: "user",
                            content: `Extract the date, item, amount, and store from this message: "${transcription}". Return in JSON format like this: {"date": "YYYY-MM-DD", "item": "ITEM", "amount": "$AMOUNT", "store": "STORE"}.`
                        }
                    ]
                });
    
                const gptParsed = JSON.parse(gptResponse.choices[0].message.content);
    
                if (gptParsed && gptParsed.item && gptParsed.amount && gptParsed.store) {
                    reply = `Did you mean: ${gptParsed.amount} for ${gptParsed.item} from ${gptParsed.store} on ${gptParsed.date}? Reply 'yes' to confirm or 'no' to correct.`;
    
                    // Store the pending GPT-3.5 result for confirmation
                    userOnboardingState[from] = { pendingExpense: gptParsed };
                } else {
                    reply = "⚠️ I couldn't parse the expense details from your voice note. Please try again or provide more details.";
                }
            }
        } else {
            reply = "⚠️ Sorry, I couldn't understand the voice note.";
        }
    }
    else if (mediaUrl && mediaType?.includes("image")) {
        // 🧾 Receipt Image Handling
        reply = await handleReceiptImage(from, mediaUrl);
    } 
    else if (body?.toLowerCase().startsWith("start job ")) {
        // 🏗️ Job Tracking Feature 
        const jobName = body.slice(10).trim();
        await setActiveJob(from, jobName);
        reply = `✅ Job '${jobName}' is now active. All expenses will be assigned to this job.`;
    } 
    else if (body?.toLowerCase().startsWith("expense summary")) {
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
    } 
    else {
        // 💬 Expense Logging via Text Message
        const activeJob = await getActiveJob(from) || "Uncategorized";
        const expenseData = parseExpenseMessage(body);

        if (expenseData) {
            // Confirm before logging
            reply = `Did you mean: ${expenseData.amount} for ${expenseData.item} from ${expenseData.store} on ${expenseData.date}? Reply 'yes' to confirm or 'no' to correct.`;
            userOnboardingState[from] = { pendingExpense: expenseData };
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

// ✅ Load Google Vision Credentials from ENV (fallback to GOOGLE_CREDENTIALS_BASE64 if missing)
const googleVisionBase64 = process.env.GOOGLE_VISION_CREDENTIALS_BASE64 || process.env.GOOGLE_CREDENTIALS_BASE64;

if (!googleVisionBase64) {
    throw new Error("[ERROR] Missing Google Vision API credentials. Ensure GOOGLE_CREDENTIALS_BASE64 is set.");
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
    console.log(`[DEBUG] Incoming Webhook Request from ${req.body.From}:`, JSON.stringify(req.body));

    const from = req.body.From;
    const body = req.body.Body?.trim().toLowerCase();
    const mediaUrl = req.body.MediaUrl0; 
    const mediaType = req.body.MediaContentType0;

    if (!from) {
        console.error("[ERROR] Webhook request missing 'From'.");
        return res.status(400).send("Bad Request: Missing 'From'.");
    }

    console.log(`[DEBUG] Incoming message from ${from}: "${body || "(Media received)"}"`);

    let reply;

    try {
        // ✅ Save User Phone Number on First Contact
        const userRef = db.collection('users').doc(from);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            await userRef.set({
                user_id: from,
                created_at: new Date().toISOString(),
                onboarding_complete: false
            });
            console.log(`[✅ SUCCESS] Phone number saved for new user: ${from}`);
        }

        // ✅ Handle User Confirmation with Quick Replies
if (userOnboardingState[from]?.pendingExpense || userOnboardingState[from]?.pendingRevenue || userOnboardingState[from]?.pendingBill) {
    const pendingData = userOnboardingState[from].pendingExpense || userOnboardingState[from].pendingRevenue || userOnboardingState[from].pendingBill;
    const type = userOnboardingState[from].pendingExpense ? 'expense' : userOnboardingState[from].pendingRevenue ? 'revenue' : 'bill';
    const activeJob = await getActiveJob(from) || "Uncategorized";

    if (body === 'yes') {
        if (type === 'bill') {
            if (pendingData.action === 'edit') {
                const updateSuccess = await updateBillInFirebase(from, pendingData);
                reply = updateSuccess 
                    ? `✏️ Bill "${pendingData.billName}" has been updated to ${pendingData.amount} due on ${pendingData.dueDate}.`
                    : `⚠️ Bill "${pendingData.billName}" was not found to update. Please check the name.`;
            } else if (pendingData.action === 'delete') {
                const deletionSuccess = await deleteBillFromFirebase(from, pendingData.billName);
                reply = deletionSuccess 
                    ? `🗑️ Bill "${pendingData.billName}" has been deleted.` 
                    : `⚠️ Bill "${pendingData.billName}" not found for deletion.`;
            } else {
                // Log bill creation to Google Sheets
                await appendToUserSpreadsheet(from, [
                    pendingData.date,
                    pendingData.billName,
                    pendingData.amount,
                    'Recurring Bill',
                    activeJob,
                    'bill',
                    'recurring'
                ]);
                reply = `✅ Bill "${pendingData.billName}" has been added for ${pendingData.amount} due on ${pendingData.dueDate}.`;
            }
        } else {
            await appendToUserSpreadsheet(from, [
                pendingData.date,
                pendingData.item || pendingData.source,
                pendingData.amount,
                pendingData.store || pendingData.source,
                activeJob,
                type
            ]);

            reply = `✅ ${type.charAt(0).toUpperCase() + type.slice(1)} confirmed and logged: ${pendingData.item || pendingData.source} for ${pendingData.amount} on ${pendingData.date}`;
        }
    } else if (body === 'no' || body === 'edit') {
        reply = "✏️ Okay, please resend the correct details.";
        delete userOnboardingState[from].pendingExpense;
        delete userOnboardingState[from].pendingRevenue;
        delete userOnboardingState[from].pendingBill;

    } else if (body === 'cancel') {
        reply = "🚫 Entry canceled.";
        delete userOnboardingState[from].pendingExpense;
        delete userOnboardingState[from].pendingRevenue;
        delete userOnboardingState[from].pendingBill;

    } else {
        reply = {
            body: `Please confirm: ${pendingData.amount} for ${pendingData.item || pendingData.source || pendingData.billName} on ${pendingData.date}`,
            persistentAction: [
                "reply?text=Yes",
                "reply?text=Edit",
                "reply?text=Cancel"
            ]
        };
    }

    return res.send(`<Response><Message>${reply}</Message></Response>`);
}

            // 🎤 Voice Note Handling
            let combinedText = '';
            if (mediaUrl && mediaType?.includes("audio")) {
                const audioResponse = await axios.get(mediaUrl, {
                    responseType: 'arraybuffer',
                    auth: {
                        username: process.env.TWILIO_ACCOUNT_SID,
                        password: process.env.TWILIO_AUTH_TOKEN
                    }
                });
                const audioBuffer = Buffer.from(audioResponse.data, 'binary');
                const transcription = await transcribeAudio(audioBuffer);

                if (transcription) {
                    combinedText += transcription + " ";
                    console.log(`[DEBUG] Voice Transcription: "${transcription}"`);
                }
            }

            // 🧾 Receipt Image Handling
            if (mediaUrl && mediaType?.includes("image")) {
                const ocrText = await extractTextFromImage(mediaUrl);

                if (ocrText) {
                    combinedText += ocrText;
                    console.log(`[DEBUG] OCR Text: "${ocrText}"`);
                }
            }

            // 📝 Parse Combined Text
if (combinedText) {
    const expenseData = parseExpenseMessage(combinedText);

    if (expenseData) {
        // ✅ Store pending expense BEFORE sending response
        userOnboardingState[from] = { pendingExpense: expenseData };

        await sendQuickReply(from, 
            `Did you mean: ${expenseData.amount} for ${expenseData.item} from ${expenseData.store} on ${expenseData.date}?`, 
            ["Yes", "Edit", "Cancel"]
        );
        return res.send(`<Response><Message>✅ Quick Reply Sent. Please respond.</Message></Response>`);
        
    } else {
        // 🚨 Fallback if parsing fails
        console.log("[DEBUG] Parsing failed. No structured expense data detected.");
        reply = "⚠️ I couldn't parse the details from your message. Please clarify.";
    }
} else {
    reply = "⚠️ No media detected or unable to extract information. Please resend.";
}
} catch (error) {
    console.error("[ERROR] Media processing failed:", error);
    reply = "⚠️ Sorry, there was an issue processing your media file. Please try again.";
}
        // 🎗️ Job Start Handling
        if (body.startsWith("start job ")) {
            reply = await handleStartJob(from, body);
        }
 //Income Goal Calculation
 if (body.includes("how much do i need to make") || body.includes("income goal")) {
    const incomeGoal = await calculateIncomeGoal(from);

    if (incomeGoal) {
        reply = `📈 To cover your expenses next month, you need to make **$${incomeGoal}**. This includes your recurring bills, average variable expenses, and a 10% savings target.`;
        res.set('Content-Type', 'text/xml');
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else {
        const reply = "⚠️ I couldn't calculate your income goal right now. Please ensure your expenses and bills are logged correctly.";
        res.set('Content-Type', 'text/xml');
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
}
       // 💬 Revenue Logging with Confirmation and GPT-3.5 Fallback
else if (body.startsWith("received") || body.startsWith("earned") || body.startsWith("income") || body.startsWith("revenue")) {
    const activeJob = await getActiveJob(from) || "Uncategorized";
    let revenueData = parseRevenueMessage(body);

    if (!revenueData) {
        console.log("[DEBUG] Regex parsing failed for revenue, using GPT-3.5 for fallback...");

        const gptResponse = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: "You are an assistant that extracts structured revenue data from messages." },
                { role: "user", content: `Extract the date, amount, and source from this revenue message: \"${body}\". Return in JSON format like this: {\"date\": \"YYYY-MM-DD\", \"amount\": \"$AMOUNT\", \"source\": \"SOURCE\"}.` }
            ]
        });

        try {
            revenueData = JSON.parse(gptResponse.choices[0].message.content);
            console.log("[DEBUG] GPT-3.5 Fallback Revenue Result:", revenueData);

            if (!revenueData.date) {
                revenueData.date = new Date().toISOString().split('T')[0];
            }

        } catch (gptError) {
            console.error("[ERROR] Failed to parse GPT-3.5 revenue response:", gptError, gptResponse);
        }
    }

    if (revenueData && revenueData.amount && revenueData.source) {
        // ✅ Store the pending revenue BEFORE sending the Quick Reply
        userOnboardingState[from] = { pendingRevenue: revenueData };

        userOnboardingState[from] = { pendingRevenue: revenueData };

await sendQuickReply(from, 
    `Did you mean: ${revenueData.amount} from ${revenueData.source} on ${revenueData.date}?`, 
    ["Yes", "Edit", "Cancel"]
);

return res.send(`<Response><Message>✅ Quick Reply Sent. Please respond.</Message></Response>`);

    } else {
        reply = "⚠️ Could not understand your revenue message. Please provide more details.";
    }
}

        // 💬 Text-Based Expense Logging with Confirmation and GPT-3.5 Fallback
else if (body) {
    const activeJob = await getActiveJob(from) || "Uncategorized";
    let expenseData = parseExpenseMessage(body);

    if (!expenseData) {
        console.log("[DEBUG] Regex parsing failed, using GPT-3.5 for fallback...");

        const gptResponse = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: "You are an assistant that extracts structured expense data from messages."
                },
                {
                    role: "user",
                    content: `Extract the date, item, amount, and store from this message: \"${body}\". Return in JSON format like this: {\"date\": \"YYYY-MM-DD\", \"item\": \"ITEM\", \"amount\": \"$AMOUNT\", \"store\": \"STORE\"}.`
                }
            ]
        });

        try {
            expenseData = JSON.parse(gptResponse.choices[0].message.content);
            console.log("[DEBUG] GPT-3.5 Fallback Result:", expenseData);

            if (!expenseData.date) {
                expenseData.date = new Date().toISOString().split('T')[0];
            }

        } catch (gptError) {
            console.error("[ERROR] Failed to parse GPT-3.5 response:", gptError, gptResponse);
        }
    }

    if (expenseData && expenseData.item && expenseData.amount && expenseData.store) {
        userOnboardingState[from] = { pendingExpense: expenseData };

await sendQuickReply(from, 
    `Did you mean: ${expenseData.amount} for ${expenseData.item} from ${expenseData.store} on ${expenseData.date}?`, 
    ["Yes", "Edit", "Cancel"]
);

return res.send(`<Response><Message>✅ Quick Reply Sent. Please respond.</Message></Response>`);

    } else {
        reply = "⚠️ Could not understand your request. Please provide a valid expense message.";
    }
}
    
    // ✅ Ensure there's always a fallback response
    if (!reply) {
        reply = "⚠️ I couldn't understand your request. Please try again with more details.";
        
        res.set('Content-Type', 'text/xml');
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }    
    // ✅ Send the final response (only if the above conditions don't trigger)
res.set('Content-Type', 'text/xml');
console.log(`[DEBUG] Reply sent to ${from}: "${reply}"`);
return res.send(`<Response><Message>${reply}</Message></Response>`);
});


// 🛠️ Helper Functions for Bill Management
async function updateBillInFirebase(userId, billData) {
    try {
        const userBillsRef = db.collection('users').doc(userId).collection('bills');
        const querySnapshot = await userBillsRef.where('billName', '==', billData.billName).get();

        if (!querySnapshot.empty) {
            const billDoc = querySnapshot.docs[0];
            await billDoc.ref.update({
                amount: billData.amount,
                dueDate: billData.dueDate,
                recurrence: billData.recurrence
            });
            console.log(`[✅ SUCCESS] Bill "${billData.billName}" updated.`);
            return true;
        } else {
            console.log(`[⚠️ WARNING] Bill "${billData.billName}" not found for update.`);
            return false;
        }
    } catch (error) {
        console.error(`[ERROR] Failed to update bill "${billData.billName}":`, error);
        return false;
    }
}

async function deleteBillFromFirebase(userId, billName) {
    try {
        const userBillsRef = db.collection('users').doc(userId).collection('bills');
        const querySnapshot = await userBillsRef.where('billName', '==', billName).get();

        if (!querySnapshot.empty) {
            const billDoc = querySnapshot.docs[0];
            await billDoc.ref.delete();
            console.log(`[✅ SUCCESS] Bill "${billName}" deleted.`);
            return true;
        } else {
            console.log(`[⚠️ WARNING] Bill "${billName}" not found for deletion.`);
            return false;
        }
    } catch (error) {
        console.error(`[ERROR] Failed to delete bill "${billName}":`, error);
        return false;
    }
}

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
