require('dotenv').config(); // Load environment variables first

// Core Node.js utilities
const { URLSearchParams } = require('url');
const fs = require('fs');
const path = require('path');

// Third-party libraries
const admin = require("firebase-admin");
const express = require('express');
const OpenAI = require('openai');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');

// Local utilities
const areaCodeMap = require('./utils/areaCodes'); // For onboarding region detection
const { parseExpenseMessage, parseRevenueMessage } = require('./utils/expenseParser');
const { inferMissingData } = require('./transcriptionService'); // For AI fallback
const {
    getUserProfile,
    saveUserProfile,
    logRevenueEntry,
    getAuthorizedClient,
    appendToUserSpreadsheet,
    getOrCreateUserSpreadsheet,
    fetchExpenseData,
    calculateExpenseAnalytics,
    setActiveJob,
    getActiveJob,
    createSpreadsheetForUser,
    calculateIncomeGoal
} = require("./utils/googleSheets");
const { extractTextFromImage } = require('./utils/visionService');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { sendSpreadsheetEmail } = require('./utils/sendGridService');
const { transcribeAudio } = require('./utils/transcriptionService');
const storeList = require('./utils/storeList');
const constructionStores = storeList.map(store => store.toLowerCase());

// Firebase Admin Setup
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

// Helper functions for state persistence in Firestore
const getOnboardingState = async (from) => {
    const stateDoc = await db.collection('onboardingStates').doc(from).get();
    return stateDoc.exists ? stateDoc.data() : null;
};

const setOnboardingState = async (from, state) => {
    await db.collection('onboardingStates').doc(from).set(state);
};

const deleteOnboardingState = async (from) => {
    await db.collection('onboardingStates').doc(from).delete();
};

// Helper functions for pending transactions
const getPendingTransactionState = async (from) => {
    const pendingDoc = await db.collection('pendingTransactions').doc(from).get();
    return pendingDoc.exists ? pendingDoc.data() : null;
};

const setPendingTransactionState = async (from, state) => {
    await db.collection('pendingTransactions').doc(from).set(state);
};

const deletePendingTransactionState = async (from) => {
    await db.collection('pendingTransactions').doc(from).delete();
};

// Utility Functions
const setLastQuery = async (from, queryData) => {
    await db.collection('lastQueries').doc(from).set(queryData, { merge: true });
};

const getLastQuery = async (from) => {
    const doc = await db.collection('lastQueries').doc(from).get();
    return doc.exists ? doc.data() : null;
};

function normalizePhoneNumber(phone) {
    return phone
        .replace(/^whatsapp:/i, '')
        .replace(/^\+/, '')
        .trim();
}

function detectCountryAndRegion(phoneNumber) {
    if (!phoneNumber.startsWith("+")) {
        phoneNumber = `+${phoneNumber}`;
    }
    const phoneInfo = parsePhoneNumberFromString(phoneNumber);
    if (!phoneInfo || !phoneInfo.isValid()) {
        return { country: "Unknown", region: "Unknown" };
    }
    const country = phoneInfo.country;
    const nationalNumber = phoneInfo.nationalNumber;
    const areaCode = nationalNumber.substring(0, 3);
    let region = "Unknown";
    if (country === 'US') {
        const usAreaCodes = { "212": "New York", "213": "Los Angeles", "305": "Miami" /*...*/ };
        region = usAreaCodes[areaCode] || "Unknown State";
    } else if (country === 'CA') {
        const caAreaCodes = { "416": "Toronto, Ontario", "604": "Vancouver, British Columbia" /*...*/ };
        region = caAreaCodes[areaCode] || "Unknown Province";
    }
    return { country, region };
}

// Express App Setup
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Onboarding Steps & State
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
const onboardingTemplates = {
    1: "HX4cf7529ecaf5a488fdfa96b931025023",
    3: "HX066a88aad4089ba4336a21116e923557",
    4: "HX1d4c5b90e5f5d7417283f3ee522436f4",
    5: "HX5c80469d7ba195623a4a3654a27c19d7",
    6: "HXd1fcd47418eaeac8a94c57b930f86674",
    7: "HX3e231458c97ba2ca1c5588b54e87c081",
    8: "HX20b1be5490ea39f3730fb9e70d5275df",
    9: "HX99fd5cad1d49ab68e9afc6a70fe4d24a"
};
const confirmationTemplates = {
    revenue: "HXb3086ca639cb4882fb2c68f2cd569cb4",
    expense: "HX9f6b7188f055fa25f8170f915e53cbd0",
    bill: "HX2f1814b7932c2a11e10b2ea8050f1614",
    startJob: "HXa4f19d568b70b3493e64933ce5e6a040"
};
// ─── SEND TEMPLATE MESSAGE FUNCTION ─────────────────────
const sendTemplateMessage = async (to, contentSid, contentVariables = {}) => {
    try {
        if (!contentSid) {
            console.error("[ERROR] Missing ContentSid for Twilio template message.");
            return false;
        }
        const toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
        const formattedVariables = JSON.stringify(contentVariables);
        console.log("[DEBUG] Sending Twilio template message with:", {
            To: toNumber,
            ContentSid: contentSid,
            ContentVariables: formattedVariables
        });
        const response = await axios.post(
            `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
            new URLSearchParams({
                From: process.env.TWILIO_WHATSAPP_NUMBER,
                To: toNumber,
                MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
                Body: "Template Message",
                ContentSid: contentSid,
                ContentVariables: formattedVariables
            }).toString(),
            {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                auth: {
                    username: process.env.TWILIO_ACCOUNT_SID,
                    password: process.env.TWILIO_AUTH_TOKEN
                }
            }
        );
        console.log(`[✅] Twilio template message sent successfully to ${toNumber} with ContentSid "${contentSid}"`);
        return true;
    } catch (error) {
        console.error("[ERROR] Twilio template message failed:", error.response?.data || error.message);
        return false;
    }
};
// ─── WEBHOOK HANDLER ─────────────────────────────
app.post('/webhook', async (req, res) => {
    const rawPhone = req.body.From;
    const from = normalizePhoneNumber(rawPhone);
    console.log(`[DEBUG] Incoming Webhook Request from ${req.body.From}:`, JSON.stringify(req.body));
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

    try {
        // ─── ONBOARDING FLOW ─────────────────────────
        if (!userProfile) {
            let state = await getOnboardingState(from);
            if (!state) {
                state = { step: 0, responses: {}, detectedLocation: detectCountryAndRegion(from) };
                await setOnboardingState(from, state);
                console.log(`[DEBUG] Initialized state for ${from}:`, state);
                const firstQuestion = onboardingSteps[0];
                console.log(`[DEBUG] Sending first question to ${from}:`, firstQuestion);
                return res.send(`<Response><Message>${firstQuestion}</Message></Response>`);
            }
            if (state.step < onboardingSteps.length) {
                state.responses[`step_${state.step}`] = body;
                console.log(`[DEBUG] Recorded response for step ${state.step}:`, body);
                state.step++;
                await setOnboardingState(from, state);
            }
            if (state.step < onboardingSteps.length) {
                const nextQuestion = onboardingSteps[state.step];
                console.log(`[DEBUG] Next question (step ${state.step}) for ${from}:`, nextQuestion);
                if (onboardingTemplates.hasOwnProperty(state.step)) {
                    const sent = await sendTemplateMessage(from, onboardingTemplates[state.step], {});
                    if (!sent) {
                        console.error("Falling back to plain text question because template message sending failed");
                        return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
                    }
                    console.log(`[DEBUG] Sent interactive template for step ${state.step} to ${from}`);
                    return res.send(`<Response></Response>`);
                } else {
                    console.log(`[DEBUG] Sending plain text for step ${state.step} to ${from}`);
                    return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
                }
            } else {
                const email = state.responses.step_10;
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(email)) {
                    return res.send(`<Response><Message>⚠️ The email address you provided doesn't seem valid. Please enter a valid email address.</Message></Response>`);
                }
                try {
                    const userProfileData = {
                        user_id: from,
                        name: state.responses.step_0,
                        country: state.responses.country || state.responses.step_1,
                        province: state.responses.province || state.responses.step_2,
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
                    await saveUserProfile(userProfileData);
                    const spreadsheetId = await createSpreadsheetForUser(from, userProfileData.email);
                    await sendSpreadsheetEmail(userProfileData.email, spreadsheetId);
                    await deleteOnboardingState(from);
                    console.log(`[DEBUG] Onboarding complete for ${from}:`, userProfileData);
                    return res.send(`<Response><Message>✅ Onboarding complete, ${userProfileData.name}! Your spreadsheet has been emailed to you.</Message></Response>`);
                } catch (error) {
                    console.error("[ERROR] Failed to complete onboarding:", error);
                    return res.send(`<Response><Message>⚠️ Sorry, something went wrong while completing your profile. Please try again later.</Message></Response>`);
                }
            }
        }
        // ─── NON-ONBOARDING FLOW (RETURNING USERS) ─────────────────────────
        else {
            let reply;

            // Check for pending transactions in Firestore
            const pendingState = await getPendingTransactionState(from);

 
 // 1. Pending Confirmations (Ensure isEditing Persists)
if (pendingState && (pendingState.pendingExpense || pendingState.pendingRevenue || pendingState.pendingBill)) {
    const pendingData = pendingState.pendingExpense || pendingState.pendingRevenue || pendingState.pendingBill;
    const type = pendingState.pendingExpense ? 'expense' : pendingState.pendingRevenue ? 'revenue' : 'bill';
    const activeJob = await getActiveJob(from) || "Uncategorized";

    if (body && body.toLowerCase() === 'yes') {
        if (type === 'bill') {
            if (pendingData.action === 'edit') {
                reply = "⚠️ Bill editing not yet implemented.";
            } else if (pendingData.action === 'delete') {
                reply = "⚠️ Bill deletion not yet implemented.";
            } else {
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
        } else if (type === 'revenue') {
            try {
                const success = await logRevenueEntry(
                    userProfile.email,
                    pendingData.date,
                    pendingData.amount,
                    pendingData.source,
                    "General Revenue",
                    "Unknown",
                    "Logged via WhatsApp",
                    userProfile.spreadsheetId
                );
                reply = success
                    ? `✅ Revenue of ${pendingData.amount} from ${pendingData.source} logged successfully.`
                    : `⚠️ Failed to log revenue. Please try again.`;
            } catch (error) {
                console.error("[ERROR] Error logging revenue:", error.message);
                reply = "⚠️ Internal server error while logging revenue. Please try again.";
            }
        } else {
            await appendToUserSpreadsheet(from, [
                pendingData.date,
                pendingData.item || pendingData.source,
                pendingData.amount,
                pendingData.store || pendingData.source,
                activeJob,
                type,
                pendingData.suggestedCategory || "General"
            ]);
            reply = `✅ ${type.charAt(0).toUpperCase() + type.slice(1)} confirmed and logged: ${pendingData.item || pendingData.source || pendingData.billName} for ${pendingData.amount} on ${pendingData.date} under ${pendingData.suggestedCategory || "General"}`;
        }
        await deletePendingTransactionState(from);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else if (body && (body.toLowerCase() === 'no' || body.toLowerCase() === 'edit')) {
        reply = "✏️ Okay, please resend the correct details.";
        // Set isEditing first, then clear other data
        await setPendingTransactionState(from, { isEditing: true });
        await deletePendingTransactionState(from);
        res.send(`<Response><Message>${reply}</Message></Response>`);
        console.log("[DEBUG] Reply sent to WhatsApp:", reply);
        return;
    } else if (body && body.toLowerCase() === 'cancel') {
        reply = "🚫 Entry canceled.";
        await deletePendingTransactionState(from);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else {
        reply = "⚠️ Please respond with 'yes', 'no', 'edit', or 'cancel' to proceed.";
        const sent = await sendTemplateMessage(
            from,
            type === 'expense' || type === 'bill' ? confirmationTemplates.expense : confirmationTemplates.revenue,
            { "1": `Please confirm: ${type === 'expense' || type === 'bill' ? `${pendingData.amount} for ${pendingData.item || pendingData.source || pendingData.billName} on ${pendingData.date}` : `Revenue of ${pendingData.amount} from ${pendingData.source} on ${pendingData.date}`}` }
        );
        if (sent) {
            return res.send(`<Response><Message>✅ Quick Reply Sent. Please respond.</Message></Response>`);
        } else {
            return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
    }
}

            // 2. Start Job Command
            if (body && /^(start job|job start)\s+(.+)/i.test(body)) {
                let jobName;
                const jobMatch = body.match(/^(start job|job start)\s+(.+)/i);
                if (jobMatch && jobMatch[2]) {
                    jobName = jobMatch[2].trim();
                }
                if (!jobName) {
                    try {
                        const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                        const gptResponse = await openaiClient.chat.completions.create({
                            model: "gpt-3.5-turbo",
                            messages: [
                                { role: "system", content: "Extract the job name from the following message. Return only the job name as plain text." },
                                { role: "user", content: `Message: "${body}"` }
                            ],
                            max_tokens: 20,
                            temperature: 0.3
                        });
                        jobName = gptResponse.choices[0].message.content.trim();
                    } catch (error) {
                        console.error("[ERROR] GPT fallback for start job failed:", error);
                    }
                }
                if (jobName) {
                    await setActiveJob(from, jobName);
                    
                    const sent = await sendTemplateMessage(
                        from,
                        "start_job", // Ensure this matches the template name in Twilio
                        [
                            { type: "text", text: jobName }
                        ]
                    );
                
                    if (sent) {
                        return res.send(`<Response><Message>✅ Quick Reply Sent. Please confirm the job.</Message></Response>`);
                } else {
                    return res.send(`<Response><Message>⚠️ Could not determine the job name. Please specify the job name.</Message></Response>`);
                }
            } else {
                return res.send(`<Response><Message>⚠️ Could not determine the job name. Please specify the job name.</Message></Response>`);
            }
        }

        // 3. Add Bill Command
else if (body && body.toLowerCase().includes("bill")) {
    console.log("[DEBUG] Detected a bill message:", body);
    const activeJob = (await getActiveJob(from)) || "Uncategorized";
    let billData = null;
    const billRegex = /bill\s+([\w\s]+)\s+\$([\d,]+(?:\.\d{1,2})?)\s+(?:per\s+)?(\w+)?\s*(?:on|due)\s+([\w\d\s,-]+)/i;
    const billMatch = body.match(billRegex);
    if (billMatch) {
        const rawRecurrence = billMatch[3] ? billMatch[3].toLowerCase() : "one-time";
        billData = {
            billName: billMatch[1].trim(),
            amount: `$${parseFloat(billMatch[2].replace(/,/g, '')).toFixed(2)}`,
            recurrence: rawRecurrence === "month" ? "monthly" : rawRecurrence,
            dueDate: billMatch[4].trim()
        };
    }

    if (!billData || !billData.billName || !billData.amount || !billData.dueDate) {
        console.log("[DEBUG] Regex parsing failed for bill, using GPT-3.5 for fallback...");
        try {
            const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const gptResponse = await openaiClient.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: "Extract bill details from the following message. Return a JSON object with keys: billName, amount, dueDate, recurrence (e.g., 'monthly', 'one-time')." },
                    { role: "user", content: `Message: "${body}"` }
                ],
                max_tokens: 60,
                temperature: 0.3
            });
            billData = JSON.parse(gptResponse.choices[0].message.content);
            billData.amount = billData.amount ? `$${parseFloat(billData.amount.replace(/[^0-9.]/g, '')).toFixed(2)}` : null;
            billData.recurrence = billData.recurrence === "month" ? "monthly" : billData.recurrence || "one-time";
        } catch (error) {
            console.error("[ERROR] GPT fallback for bill parsing failed:", error);
        }
    }

    if (billData && billData.billName && billData.amount && billData.dueDate) {
        // Refine due date format (e.g., "March 1, 2025" → "March 1st")
        const dateParts = billData.dueDate.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})/i);
        let refinedDueDate = billData.dueDate;
        if (dateParts) {
            const month = dateParts[1];
            const day = parseInt(dateParts[2], 10);
            const year = dateParts[3];
            const dayWithSuffix = day === 1 ? "1st" : day === 2 ? "2nd" : day === 3 ? "3rd" : `${day}th`;
            refinedDueDate = `${month} ${dayWithSuffix}`;
        }

        await setPendingTransactionState(from, { pendingBill: billData });
        const sent = await sendTemplateMessage(
            from,
            confirmationTemplates.bill, // "HX2f1814b7932c2a11e10b2ea8050f1614"
            {
                "1": billData.amount, // Amount for current template
                "2": refinedDueDate,  // Due Date for current template
                "3": billData.recurrence.charAt(0).toUpperCase() + billData.recurrence.slice(1) // Recurrence for current template
                // "1": billData.billName, // Uncomment and adjust indices when new template is approved
                // "2": billData.amount,
                // "3": refinedDueDate,
                // "4": billData.recurrence.charAt(0).toUpperCase() + billData.recurrence.slice(1)
            }
        );
        if (sent) {
            console.log("[DEBUG] Twilio template sent successfully, no additional message sent to WhatsApp.");
            return res.send(`<Response></Response>`);
        } else {
            return res.send(`<Response><Message>⚠️ Failed to send bill confirmation. Please try again.</Message></Response>`);
        }
    } else {
        return res.send(`<Response><Message>⚠️ Could not parse bill details. Please provide the details in the format: "bill [name] $[amount] due [date]" or "bill [name] $[amount] per [period] on [date]".</Message></Response>`);
    }
}
            // 4. Revenue Logging Branch
            else if (
                body && (
                    body.toLowerCase().includes("received") ||
                    body.toLowerCase().includes("earned") ||
                    body.toLowerCase().includes("income") ||
                    body.toLowerCase().includes("revenue") ||
                    body.toLowerCase().includes("was paid") ||
                    body.toLowerCase().includes("was payed") ||
                    body.toLowerCase().includes("got payed") ||
                    body.toLowerCase().includes("collected") ||
                    body.toLowerCase().includes("got a cheque") ||
                    body.toLowerCase().includes("received a cheque") ||
                    body.toLowerCase().includes("collected a cheque") ||
                    body.toLowerCase().includes("got a check") ||
                    body.toLowerCase().includes("received a check") ||
                    body.toLowerCase().includes("collected a check") ||
                    body.toLowerCase().includes("got a cashapp") ||
                    body.toLowerCase().includes("got an etransfer") ||
                    body.toLowerCase().includes("received an etransfer") ||
                    body.toLowerCase().includes("got paid")
                )
            ) {
                console.log("[DEBUG] Detected a revenue message:", body);
                const activeJob = (await getActiveJob(from)) || "Uncategorized";
                let revenueData = parseRevenueMessage(body);

                if (!revenueData || !revenueData.amount || !revenueData.source) {
                    console.log("[DEBUG] Regex parsing failed for revenue, using GPT-3.5 for fallback...");
                    try {
                        const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                        const gptResponse = await openaiClient.chat.completions.create({
                            model: "gpt-3.5-turbo",
                            messages: [
                                { role: "system", content: "Extract structured revenue data from the following message. Return JSON with keys: date, amount, source." },
                                { role: "user", content: `Message: "${body}"` }
                            ],
                            max_tokens: 60,
                            temperature: 0.3
                        });
                        revenueData = JSON.parse(gptResponse.choices[0].message.content);
                        revenueData.amount = revenueData.amount ? String(revenueData.amount).trim() : "";
                        revenueData.source = revenueData.source ? revenueData.source.trim() : "";
                        if (!revenueData.date) {
                            revenueData.date = new Date().toISOString().split("T")[0];
                        }
                        console.log("[DEBUG] GPT-3.5 Fallback Revenue Result:", revenueData);
                    } catch (error) {
                        console.error("[ERROR] GPT-3.5 revenue parsing failed:", error);
                    }
                    if (!revenueData || !revenueData.amount || !revenueData.source) {
                        return res.send(`<Response><Message>⚠️ Could not understand your revenue message. Please provide more details.</Message></Response>`);
                    }
                }
                console.log("[DEBUG] Revenue data ready:", revenueData);
    await setPendingTransactionState(from, { pendingRevenue: revenueData });
    const sent = await sendTemplateMessage(
        from,
        confirmationTemplates.revenue, // "HXb3086ca639cb4882fb2c68f2cd569cb4"
        { "1": `Revenue of ${revenueData.amount} from ${revenueData.source} on ${revenueData.date}` }
    );
    if (sent) {
        console.log("[DEBUG] Twilio template sent successfully, no additional message sent to WhatsApp.");
        return res.send(`<Response></Response>`); // Empty response to hide "Quick Reply Sent"
    } else {
        return res.send(`<Response><Message>⚠️ Failed to send revenue confirmation. Please try again.</Message></Response>`);
    }
}
// 5. Metrics Queries
else if (body && (body.toLowerCase().includes("how much") || 
                  body.toLowerCase().includes("profit") || 
                  body.toLowerCase().includes("margin") || 
                  body.toLowerCase().includes("spend") || 
                  body.toLowerCase().includes("spent") || // Added for broader coverage
                  body.toLowerCase().includes("how about") || // Catch "How about 74 Hampton?"
                  /\d+\s+[a-zA-Z]+\s*(street|st|avenue|ave|road|rd|job)?/i.test(body))) { // Catch "74 Hampton"
    console.log("[DEBUG] Detected a metrics query:", body);
    const activeJob = (await getActiveJob(from)) || "Uncategorized";
    const spreadsheetId = userProfile.spreadsheetId;

    console.log("[DEBUG] Attempting to authorize Google Sheets client...");
    const auth = await getAuthorizedClient();
    console.log("[DEBUG] Google Sheets client authorized successfully.");
    const sheets = google.sheets({ version: 'v4', auth });

    const expenseRange = 'Sheet1!A:G';
    const revenueRange = 'Revenue!A:F';

    let expenses = [];
    let revenues = [];
    let bills = [];

    try {
        const expenseResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: expenseRange });
        const allRows = expenseResponse.data.values || [];
        expenses = allRows.slice(1).filter(row => row[5] === "expense"); // Skip header
        bills = allRows.slice(1).filter(row => row[5] === "bill");
        console.log("[DEBUG] Retrieved expenses:", expenses);

        const revenueResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: revenueRange });
        revenues = (revenueResponse.data.values || []).slice(1); // Skip header
        console.log("[DEBUG] Retrieved revenues:", revenues);
    } catch (error) {
        console.error("[ERROR] Failed to fetch data from Google Sheets:", error);
        return res.send(`<Response><Message>⚠️ Could not retrieve your data. Please try again later.</Message></Response>`);
    }

    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextMonthStr = nextMonth.toISOString().split('T')[0].slice(0, 7);

    const parseAmount = (amountStr) => parseFloat(amountStr.replace(/[^0-9.-]/g, '')) || 0;

    // Example 1: "How much do I need to make to ensure that I can pay all of my bills next month?"
    if (body.toLowerCase().includes("need to make") && body.toLowerCase().includes("bills") && body.toLowerCase().includes("next month")) {
        const nextMonthBills = bills.filter(row => row[0].startsWith(nextMonthStr));
        const totalBills = nextMonthBills.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        return res.send(`<Response><Message>You need to make $${totalBills.toFixed(2)} to cover your bills for ${nextMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}.</Message></Response>`);
    }

    // Example 2: "What was my profit margin on Job 75 Hampton?"
    if (body.toLowerCase().includes("profit") && body.toLowerCase().includes("job")) {
        const jobName = body.match(/job\s+([\w\s]+)/i)?.[1]?.trim() || activeJob;
        const jobExpenses = expenses.filter(row => row[4] === jobName);
        const jobRevenues = revenues.filter(row => row[1] === jobName);
        const totalExpenses = jobExpenses.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        const totalRevenue = jobRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        const profit = totalRevenue - totalExpenses;
        await setLastQuery(from, { intent: "profit", timestamp: new Date().toISOString() });
        return res.send(`<Response><Message>Your profit on Job ${jobName} is $${profit.toFixed(2)}...</Message></Response>`);
      }

    // Example 3: "How much did I spend on materials on Job 75 Hampton?"
    if (body.toLowerCase().includes("spend") && body.toLowerCase().includes("materials") && body.toLowerCase().includes("job")) {
        const jobName = body.match(/job\s+([\w\s]+)/i)?.[1]?.trim() || activeJob;
        const materialExpenses = expenses.filter(row => row[4] === jobName && row[6] === "Construction Materials");
        const totalMaterialCost = materialExpenses.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        return res.send(`<Response><Message>You spent $${Math.abs(totalMaterialCost).toFixed(2)} on materials for Job ${jobName}.</Message></Response>`);
    }

    // Example 4: "How much profit did I make in February?"
    if (body.toLowerCase().includes("profit") && body.toLowerCase().includes("in") && body.toLowerCase().match(/(january|february|march|april|may|june|july|august|september|october|november|december)/i)) {
        const monthMatch = body.toLowerCase().match(/(january|february|march|april|may|june|july|august|september|october|november|december)/i)[1];
        const monthIndex = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(monthMatch);
        const year = new Date().getFullYear();
        const monthStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
        const monthExpenses = expenses.filter(row => row[0].startsWith(monthStr));
        const monthRevenues = revenues.filter(row => row[0].startsWith(monthStr));
        const totalExpenses = monthExpenses.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        const totalRevenue = monthRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        const profit = totalRevenue - totalExpenses; // Fixed
        return res.send(`<Response><Message>You made a profit of $${profit.toFixed(2)} in ${monthMatch.charAt(0).toUpperCase() + monthMatch.slice(1)} (Revenue: $${totalRevenue.toFixed(2)}, Expenses: $${Math.abs(totalExpenses).toFixed(2)}).</Message></Response>`);
    }

    // Example 5: "How much profit have I made year to date?"
    if (body.toLowerCase().includes("profit") && body.toLowerCase().includes("year to date")) {
        const yearStr = now.getFullYear().toString();
        const ytdExpenses = expenses.filter(row => row[0].startsWith(yearStr));
        const ytdRevenues = revenues.filter(row => row[0].startsWith(yearStr));
        const totalExpenses = ytdExpenses.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        const totalRevenue = ytdRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        const profit = totalRevenue - totalExpenses;
        await setLastQuery(from, { intent: "profit", timestamp: new Date().toISOString() });
        return res.send(`<Response><Message>Your year-to-date profit is $${profit.toFixed(2)} (Revenue: $${totalRevenue.toFixed(2)}, Expenses: $${Math.abs(totalExpenses).toFixed(2)}).</Message></Response>`);
    }

    // Example 6: "What are my total expenses this month?"
    if (body.toLowerCase().includes("total expenses") && body.toLowerCase().includes("this month")) {
        const thisMonthStr = now.toISOString().split('T')[0].slice(0, 7);
        const thisMonthExpenses = expenses.filter(row => row[0].startsWith(thisMonthStr));
        const totalExpenses = thisMonthExpenses.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        return res.send(`<Response><Message>Your total expenses this month are $${Math.abs(totalExpenses).toFixed(2)}.</Message></Response>`);
    }

    // Example 7: "How much revenue did I make on Job 75 Hampton?"
    if (body.toLowerCase().includes("revenue") && body.toLowerCase().includes("job")) {
        const jobName = body.match(/job\s+([\w\s]+)/i)?.[1]?.trim() || activeJob;
        const jobRevenues = revenues.filter(row => row[1] === jobName); // Assuming source/job in column B
        const totalRevenue = jobRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        return res.send(`<Response><Message>You made $${totalRevenue.toFixed(2)} in revenue on Job ${jobName}.</Message></Response>`);
    }

    // Example 8: "What’s my average monthly profit this year?"
    if (body.toLowerCase().includes("average monthly profit") && body.toLowerCase().includes("this year")) {
        const yearStr = now.getFullYear().toString();
        const ytdExpenses = expenses.filter(row => row[0].startsWith(yearStr));
        const ytdRevenues = revenues.filter(row => row[0].startsWith(yearStr));
        const totalExpenses = ytdExpenses.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        const totalRevenue = ytdRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        const profit = totalRevenue - totalExpenses; // Fixed
        const monthsSoFar = now.getMonth() + 1;
        const avgProfit = profit / monthsSoFar;
        return res.send(`<Response><Message>Your average monthly profit this year is $${avgProfit.toFixed(2)} (Total Profit: $${profit.toFixed(2)} over ${monthsSoFar} months).</Message></Response>`);
    }

    // AI Fallback for imprecise queries or help requests
        console.log("[DEBUG] No exact match found, falling back to AI interpretation...");
        try {
          const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
          const lastQuery = await getLastQuery(from);
          const contextMessage = lastQuery && (new Date().getTime() - new Date(lastQuery.timestamp).getTime()) < 5 * 60 * 1000 // 5-minute window
            ? `The user recently asked about "${lastQuery.intent}" metrics. If this query seems like a follow-up (e.g., asking about another job), assume they want the same metric type unless specified otherwise.`
            : "No recent context available.";
          
          const gptResponse = await openaiClient.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
              { 
                role: "system", 
                content: `You are an assistant interpreting financial metrics queries for a construction business. The user has expense data in 'Sheet1!A:G' (Date, Item, Amount, Store, Job, Type, Category) and revenue data in 'Revenue!A:F' (Date, Source, Amount, ...). Interpret the user's query and return a JSON object with: { intent: 'profit|spend|revenue|margin|help|unknown', job: 'job name or null', period: 'year to date|this month|specific month|null', response: 'text to send back' }. ${contextMessage} For 'help' intent, provide a list of capabilities. For metrics intents, extract job names (e.g., '74 Hampton') or periods if present, and suggest a corrected query if unclear.` 
              },
              { role: "user", content: `Query: "${body.trim()}"` }
            ],
            max_tokens: 150,
            temperature: 0.3
          });
          const aiResult = JSON.parse(gptResponse.choices[0].message.content);
          console.log("[DEBUG] AI Interpretation Result:", aiResult);
      
          if (aiResult.intent === "help") {
            return res.send(`<Response><Message>${aiResult.response || "I’m here to help you manage your construction business finances! You can:\n- Log expenses (e.g., '$50 for nails from Home Depot')\n- Track revenue (e.g., 'Received $500 from client')\n- Check profits (e.g., 'How much profit have I made year to date?')\n- Monitor spending (e.g., 'How much did I spend on Job 74 Hampton?')\nWhat would you like to try?"}</Message></Response>`);
        } else if (aiResult.intent === "profit" && aiResult.job) {
            const jobName = aiResult.job;
            const jobExpenses = expenses.filter(row => row[4] === jobName);
            const jobRevenues = revenues.filter(row => row[1] === jobName);
            const totalExpenses = jobExpenses.reduce((sum, row) => sum + parseAmount(row[2]), 0);
            const totalRevenue = jobRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
            const profit = totalRevenue - totalExpenses;
            await setLastQuery(from, { intent: "profit", timestamp: new Date().toISOString() });
            return res.send(`<Response><Message>${aiResult.response || `Profit for Job ${jobName} is $${profit.toFixed(2)} (Revenue: $${totalRevenue.toFixed(2)}, Expenses: $${Math.abs(totalExpenses).toFixed(2)}).`}</Message></Response>`);
        } else if (aiResult.intent === "unknown") {
            // Fall through to next branch if AI can’t resolve
            console.log("[DEBUG] AI fallback deemed query unknown, proceeding to next branch...");
        } else {
            return res.send(`<Response><Message>${aiResult.response || "⚠️ I couldn’t understand your request. Try 'How much profit on Job 74 Hampton?'"}</Message></Response>`);
        }
    } catch (error) {
        console.error("[ERROR] AI fallback failed:", error.message);
        return res.send(`<Response><Message>⚠️ I couldn’t process your request...</Message></Response>`);
    }
} 

    //6. Media Handling
    else if (mediaUrl) {
        console.log("[DEBUG] Checking media in message...");
        let combinedText = "";
    
        if (mediaType && mediaType.includes("audio")) {
            try {
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
                } else {
                    console.log("[DEBUG] No transcription returned from audio.");
                }
            } catch (error) {
                console.error("[ERROR] Failed to process audio:", error.message);
                return res.send(`<Response><Message>⚠️ Failed to process audio. Please try again.</Message></Response>`);
            }
        } else if (mediaType && mediaType.includes("image")) {
            try {
                console.log(`[DEBUG] Processing image from ${mediaUrl}`);
                const ocrResult = await extractTextFromImage(mediaUrl);
                console.log(`[DEBUG] OCR Result: ${JSON.stringify(ocrResult)}`);
    
                if (ocrResult && typeof ocrResult === 'object' && ocrResult.text) {
                    combinedText += ocrResult.text + " ";
                    console.log(`[DEBUG] Extracted text from OCR: "${ocrResult.text}"`);
                } else {
                    console.error("[ERROR] OCR did not return valid text data:", ocrResult);
                    return res.send(`<Response><Message>⚠️ No text extracted from the image. Please try again.</Message></Response>`);
                }
            } catch (err) {
                console.error("[ERROR] OCR extraction error:", err.message);
                return res.send(`<Response><Message>⚠️ Could not extract data from image. Please try again.</Message></Response>`);
            }
        }
    
        if (combinedText) {
            let expenseData;
            if (mediaType && mediaType.includes("audio")) {
                expenseData = parseExpenseMessage(combinedText);
            }
    
            if (!mediaType || mediaType.includes("image") || !expenseData || !expenseData.item || !expenseData.amount || expenseData.amount === "$0.00" || !expenseData.store) {
                console.log("[DEBUG] Regex parsing failed or media is an image, using GPT-3.5 for fallback...");
                try {
                    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                    const gptResponse = await openaiClient.chat.completions.create({
                        model: "gpt-3.5-turbo",
                        messages: [
                            { 
                                role: "system", 
                                content: "Extract structured expense data from the following receipt text. Use the 'TOTAL' amount if present (e.g., '$150.00'). Identify the store name from the top of the receipt (e.g., 'Standing Stone Gas'). For fuel receipts, set item to 'Fuel' unless a specific item is explicitly listed before the total. Return JSON with keys: date, item, amount, store. Correct 'roof Mark' or 'roof Mart' to 'Roofmart'. If date is missing, use today's date." 
                            },
                            { role: "user", content: `Text: "${combinedText.trim()}"` }
                        ],
                        max_tokens: 60,
                        temperature: 0.3
                    });
                    expenseData = JSON.parse(gptResponse.choices[0].message.content);
                    console.log("[DEBUG] GPT-3.5 Initial Result:", expenseData);
    
                    if (!expenseData.date || expenseData.date.toLowerCase() === "yesterday") {
                        const yesterday = new Date();
                        yesterday.setDate(yesterday.getDate() - 1);
                        expenseData.date = yesterday.toISOString().split("T")[0];
                    } else if (expenseData.date.toLowerCase() === "today") {
                        expenseData.date = new Date().toISOString().split("T")[0];
                    }
                    expenseData.amount = expenseData.amount ? String(`$${parseFloat(expenseData.amount.replace(/[^0-9.]/g, '')).toFixed(2)}`) : null;
    
                    const storeLower = expenseData.store.toLowerCase().replace(/\s+/g, '');
                    const matchedStore = storeList.find(store => {
                        const normalizedStore = store.toLowerCase().replace(/\s+/g, '');
                        return normalizedStore === storeLower || 
                               storeLower.includes(normalizedStore) || 
                               normalizedStore.includes(storeLower);
                    }) || storeList.find(store => 
                        store.toLowerCase().includes("roofmart") && 
                        (expenseData.store.toLowerCase().includes("roof") || expenseData.store.toLowerCase().includes("mart"))
                    );
                    expenseData.store = matchedStore || expenseData.store;
                    expenseData.suggestedCategory = matchedStore || constructionStores.some(store => 
                        expenseData.store.toLowerCase().includes(store)) 
                        ? "Construction Materials" : "General";
    
                    console.log("[DEBUG] GPT-3.5 Post-Processed Expense Result:", expenseData);
                } catch (error) {
                    console.error("[ERROR] GPT-3.5 expense parsing failed:", error.message);
                    return res.send(`<Response><Message>⚠️ Failed to parse media expense. Please try again.</Message></Response>`);
                }
            }
            if (expenseData && expenseData.item && expenseData.amount && expenseData.amount !== "$0.00" && expenseData.store) {
                await setPendingTransactionState(from, { pendingExpense: expenseData });
                const sent = await sendTemplateMessage(
                    from,
                    confirmationTemplates.expense,
                    { "1": `Expense of ${expenseData.amount} for ${expenseData.item} from ${expenseData.store} on ${expenseData.date}` }
                );
                if (sent) {
                    console.log("[DEBUG] Twilio template sent successfully, no additional message sent to WhatsApp.");
                    return res.send(`<Response></Response>`);
                } else {
                    return res.send(`<Response><Message>⚠️ Failed to send confirmation. Please try again.</Message></Response>`);
                }
            } else {
                return res.send(`<Response><Message>⚠️ I couldn't parse a valid expense amount from the media. Please try again.</Message></Response>`);
            }
        } else {
            console.log("[DEBUG] No audio or supported media type detected (e.g., image ignored if not processed).");
            return res.send(`<Response><Message>⚠️ No media detected or unable to extract information. Please resend.</Message></Response>`);
        }
    }
       // 7. Text Expense Logging (Updated to Handle Edit Directly)
else if (body) {
    console.log("[DEBUG] Attempting to parse expense message:", body);
    const activeJob = (await getActiveJob(from)) || "Uncategorized";
    const pendingState = await getPendingTransactionState(from);
    let expenseData;

    console.log("[DEBUG] Pending state before parsing:", pendingState); // Debug state

    // Check if this is an edit response
    if (pendingState && pendingState.isEditing) {
        console.log("[DEBUG] Detected edit response, processing user text directly...");
        // Match formats: "Expense of $amount for item from store on date", "$amount for item from/at store on date", or "Spent $amount on item from store on date"
        const editMatch = body.match(/(?:Expense of |Spent )?\$([\d.]+) (?:for|on) (.+?) (?:from|at) (.+?) on (\d{4}-\d{2}-\d{2})/i);
        if (editMatch) {
            expenseData = {
                amount: `$${parseFloat(editMatch[1]).toFixed(2)}`,
                item: editMatch[2].trim(),
                store: editMatch[3].trim(),
                date: editMatch[4].trim(),
            };
            console.log("[DEBUG] Directly parsed edit entry:", expenseData);
            // Clear edit flag only after successful parsing
            await setPendingTransactionState(from, { isEditing: false });
        } else {
            console.log("[DEBUG] Edit text format invalid, falling back to GPT-3.5...");
            try {
                const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                const gptResponse = await openaiClient.chat.completions.create({
                    model: "gpt-3.5-turbo",
                    messages: [
                        { 
                            role: "system", 
                            content: "Extract structured expense data from the following text as an edit response. Expect formats like 'Expense of $amount for item from store on date', '$amount for item at store on date', or 'Spent $amount on item from store on date'. Return JSON with keys: date, item, amount, store. Correct 'roof Mark' or 'roof Mart' to 'Roofmart'. If date is missing, use today's date." 
                        },
                        { role: "user", content: `Text: "${body.trim()}"` }
                    ],
                    max_tokens: 60,
                    temperature: 0.3
                });
                expenseData = JSON.parse(gptResponse.choices[0].message.content);
                console.log("[DEBUG] GPT-3.5 Initial Result:", expenseData);
                await setPendingTransactionState(from, { isEditing: false });
            } catch (error) {
                console.error("[ERROR] GPT-3.5 expense parsing failed:", error.message);
                return res.send(`<Response><Message>⚠️ Could not understand your edited expense message. Please try again.</Message></Response>`);
            }
        }
    }

    // Normal text parsing if not editing or edit parsing failed
    if (!expenseData) {
        expenseData = parseExpenseMessage(body);
        if (!expenseData || !expenseData.item || !expenseData.amount || expenseData.amount === "$0.00" || !expenseData.store) {
            console.log("[DEBUG] Regex parsing failed or amount invalid for expense, using GPT-3.5 for fallback...");
            try {
                const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                const gptResponse = await openaiClient.chat.completions.create({
                    model: "gpt-3.5-turbo",
                    messages: [
                        { 
                            role: "system", 
                            content: "Extract structured expense data from the following text. Expect formats like 'Expense of $amount for item from store on date', '$amount for item at store on date', or 'Spent $amount on item from store on date'. Return JSON with keys: date, item, amount, store. Correct 'roof Mark' or 'roof Mart' to 'Roofmart'. If date is missing, use today's date." 
                        },
                        { role: "user", content: `Text: "${body.trim()}"` }
                    ],
                    max_tokens: 60,
                    temperature: 0.3
                });
                expenseData = JSON.parse(gptResponse.choices[0].message.content);
                console.log("[DEBUG] GPT-3.5 Initial Result:", expenseData);
            } catch (error) {
                console.error("[ERROR] GPT-3.5 expense parsing failed:", error.message);
                return res.send(`<Response><Message>⚠️ Could not understand your expense message. Please try again.</Message></Response>`);
            }
        }
    }

    if (expenseData && expenseData.item && expenseData.amount && expenseData.amount !== "$0.00" && expenseData.store) {
        if (!expenseData.date) {
            expenseData.date = new Date().toISOString().split("T")[0];
        }
        expenseData.amount = expenseData.amount.replace(/[^0-9.]/g, '');
        expenseData.amount = `$${parseFloat(expenseData.amount).toFixed(2)}`;

        const storeLower = expenseData.store.toLowerCase().replace(/\s+/g, '');
        const matchedStore = storeList.find(store => {
            const normalizedStore = store.toLowerCase().replace(/\s+/g, '');
            return normalizedStore === storeLower || 
                   storeLower.includes(normalizedStore) || 
                   normalizedStore.includes(storeLower);
        }) || storeList.find(store => 
            store.toLowerCase().includes("roofmart") && 
            (expenseData.store.toLowerCase().includes("roof") || expenseData.store.toLowerCase().includes("mart"))
        );
        expenseData.store = matchedStore || expenseData.store;
        expenseData.suggestedCategory = matchedStore || constructionStores.some(store => 
            expenseData.store.toLowerCase().includes(store)) 
            ? "Construction Materials" : "General";

        console.log("[DEBUG] Final Expense Data:", expenseData);

        await setPendingTransactionState(from, { pendingExpense: expenseData });
        const sent = await sendTemplateMessage(
            from,
            confirmationTemplates.expense,
            { "1": `Expense of ${expenseData.amount} for ${expenseData.item} from ${expenseData.store} on ${expenseData.date}` }
        );
        if (sent) {
            console.log("[DEBUG] Twilio template sent successfully, no additional message sent to WhatsApp.");
            return res.send(`<Response></Response>`);
        } else {
            return res.send(`<Response><Message>⚠️ Failed to send expense confirmation. Please try again.</Message></Response>`);
        }
    } else {
        return res.send(`<Response><Message>⚠️ Could not understand your expense message. Please try again.</Message></Response>`);
    }
}
           
            // Default response for unhandled messages
            reply = "⚠️ Sorry, I didn't understand that. Please provide an expense, revenue, or job command.";
            return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
    } catch (error) {
        console.error("[ERROR] Processing webhook request failed:", error);
        return res.send(`<Response><Message>⚠️ Internal Server Error. Please try again.</Message></Response>`);
    }
});



// ─── Helper Functions for Bill Management ─────────────────────────────
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

async function handleStartJob(from, body) {
    const jobMatch = body.match(/^(?:start job|job start)\s+(.+)/i);
    if (!jobMatch) return "⚠️ Please specify a job name. Example: 'Start job 75 Hampton Crt'";
    const jobName = jobMatch[1].trim();
    await setActiveJob(from, jobName);
    return `✅ Job '${jobName}' is now active. All expenses will be assigned to this job.`;
}

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

// ─── GET Route for Server Verification ─────────────────────────────
app.get('/', (req, res) => {
    console.log("[DEBUG] GET request received at root URL.");
    res.send("Webhook server is up and running!");
});

// ─── Start Express Server ────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`[DEBUG] Webhook server running at http://localhost:${PORT}`);
});

// Debugging environment variables and initializing Google Vision credentials (unchanged)
console.log("[DEBUG] Checking environment variables...");
console.log("[DEBUG] GOOGLE_CREDENTIALS_BASE64:", process.env.GOOGLE_CREDENTIALS_BASE64 ? "Loaded" : "Missing");
console.log("[DEBUG] FIREBASE_CREDENTIALS_BASE64:", process.env.FIREBASE_CREDENTIALS_BASE64 ? "Loaded" : "Missing");
console.log("[DEBUG] OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "Loaded" : "Missing");

const googleVisionBase64 = process.env.GOOGLE_VISION_CREDENTIALS_BASE64 || process.env.GOOGLE_CREDENTIALS_BASE64;
if (!googleVisionBase64) {
    throw new Error("[ERROR] Missing Google Vision API credentials. Ensure GOOGLE_CREDENTIALS_BASE64 is set.");
}
const visionCredentialsPath = "/tmp/google-vision-key.json";
fs.writeFileSync(visionCredentialsPath, Buffer.from(googleVisionBase64, 'base64'));
process.env.GOOGLE_APPLICATION_CREDENTIALS = visionCredentialsPath;
console.log("[DEBUG] Google Vision Application Credentials set successfully.");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
const environment = process.env.NODE_ENV || 'development';
console.log(`[DEBUG] Environment: ${environment}`);

module.exports = app;
