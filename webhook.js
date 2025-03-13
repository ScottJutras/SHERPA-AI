require('dotenv').config();
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
const areaCodeMap = require('./utils/areaCodes');
const { parseExpenseMessage, parseRevenueMessage } = require('./utils/expenseParser');
const { detectErrors } = require('./utils/errorDetector');
const { suggestCorrections } = require('./utils/aiCorrection');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('./utils/stateManager');
const { sendTemplateMessage } = require('./utils/twilioHelper');
const { updateUserTokenUsage, checkTokenLimit, getSubscriptionTier } = require('./utils/tokenManager');
const { transcribeAudio, inferMissingData } = require('./utils/transcriptionService');
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
    calculateIncomeGoal,
    fetchMaterialPrices,
} = require("./utils/googleSheets");
const { extractTextFromImage } = require('./utils/visionService');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { sendSpreadsheetEmail } = require('./utils/sendGridService');
const { generateQuotePDF } = require('./utils/pdfService');
const { parseQuoteMessage, buildQuoteDetails } = require('./utils/quoteUtils');
const storeList = require('./utils/storeList');
const constructionStores = storeList.map(store => store.toLowerCase());
const { getTaxRate } = require('./utils/taxRate');


// Near the top of webhook.js, after imports
const googleCredentials = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
console.log('[DEBUG] Service account email from GOOGLE_CREDENTIALS_BASE64:', googleCredentials.client_email);
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

const setLastQuery = async (from, queryData) => {
    await db.collection('lastQueries').doc(from).set(queryData, { merge: true });
};

const getLastQuery = async (from) => {
    const doc = await db.collection('lastQueries').doc(from).get();
    return doc.exists ? doc.data() : null;
};

const finishJob = async (phoneNumber, jobName) => {
    const timestamp = new Date().toISOString();
    const userRef = db.collection('users').doc(phoneNumber);
    const doc = await userRef.get();
    const jobHistory = doc.data().jobHistory || [];
    const updatedHistory = jobHistory.map(job => 
        job.jobName === jobName && job.status === 'active' 
            ? { ...job, endTime: timestamp, status: 'finished' } 
            : job
    );
    await userRef.set({ activeJob: null, jobHistory: updatedHistory }, { merge: true });
    console.log(`[✅] Job ${jobName} finished at ${timestamp}`);
};

// Utility Functions
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
    const nationalNumber = phoneInfo.nationalNumber;
    const areaCode = nationalNumber.substring(0, 3);
    const location = areaCodeMap[areaCode];
    if (location) {
        return {
            country: location.country,
            region: location.province || location.state || "Unknown"
        };
    }
    return {
        country: phoneInfo.country || "Unknown",
        region: "Unknown"
    };
}

// Express App Setup
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());


const onboardingSteps = [
    "Can I get your name?", // Step 0
    "We detected your location as {{detectedLocation.country}}, {{detectedLocation.region}}. Is this correct? (Yes/No)", // Step 1 (confirmation)
    "Please enter your country if different:", // Step 1 (manual)
    "Please enter your province or state if different:", // Step 2 (manual)
    "What type of business do you have? (Sole Proprietorship, Corporation, Charity, Non-Profit, Other)", // Step 4
    "What industry do you work in? (Construction, Real Estate, Retail, Freelancer, Other)", // Step 5
    "Do you want to track personal expenses too? (Yes/No)", // Step 6
    "Do you want to track mileage? (Yes/No)", // Step 7
    "Do you want to track home office deductions? (Yes/No)", // Step 8
    "What is your primary financial goal? (Save to pay off debts, Save to invest, Spend to lower tax bracket, Spend to invest)", // Step 9
    "Would you like to add your yearly, monthly, weekly, or bi-weekly bills to track? (Yes/No)", // Step 10
    "Can I get your email address?", // Step 11 (or 10 if manual location)
    "Do you need to send quotes to your potential customers? (Yes/No)", // Step 12
    "What is your company name?", // Step 13
    "What is your sales tax registration number? (Optional, reply 'skip' if none)", // Step 14
    "What is your business address?", // Step 15
    "What is your business phone number?", // Step 16
    "Would you like to upload your company logo? (Yes/No, reply with image if Yes)" // Step 17
];

const onboardingTemplates = {
    1: "HX4cf7529ecaf5a488fdfa96b931025023", // Location confirmation
    4: "HX066a88aad4089ba4336a21116e923557", // Business type (previously misnumbered as 3)
    5: "HX1d4c5b90e5f5d7417283f3ee522436f4", // Industry
    6: "HX5c80469d7ba195623a4a3654a27c19d7", // Personal expenses
    7: "HXd1fcd47418eaeac8a94c57b930f86674", // Mileage tracking
    8: "HX3e231458c97ba2ca1c5588b54e87c081", // Home office deductions
    9: "HX20b1be5490ea39f3730fb9e70d5275df", // Financial goal
    10: "HX99fd5cad1d49ab68e9afc6a70fe4d24a" // Bills tracking
};

const confirmationTemplates = {
    revenue: "HXb3086ca639cb4882fb2c68f2cd569cb4",
    expense: "HX9f6b7188f055fa25f8170f915e53cbd0",
    bill: "HX6de403c09a8ec90183fbb3fe05413252",
    startJob: "HXa4f19d568b70b3493e64933ce5e6a040",
    locationConfirmation: "HX0280df498999848aaff04cc079e16c31",
    spreadsheetLink: "HXf5964d5ffeecc5e7f4e94d7b3379e084"
};

// Send Template Message Function
const sendTemplateMessage = async (to, contentSid, contentVariables = {}) => {
    try {
        if (!contentSid) {
            console.error("[ERROR] Missing ContentSid for Twilio template message.");
            return false;
        }
        const toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
        const formattedVariables = JSON.stringify(
            Array.isArray(contentVariables)
                ? contentVariables.reduce((acc, item, index) => {
                      acc[index + 1] = item.text;
                      return acc;
                  }, {})
                : contentVariables
        );
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
// Webhook Handler
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

    // Initialize userProfile outside try block
    let userProfile = await getUserProfile(from);
    if (!userProfile) {
        try {
            await db.collection('users').doc(from).set(
                {
                    user_id: from,
                    created_at: new Date().toISOString(),
                    onboarding_in_progress: true
                },
                { merge: true }
            );
            console.log(`[✅] Initial user profile created for ${from}`);
            userProfile = await getUserProfile(from);
        } catch (error) {
            console.error("[ERROR] Failed to create user profile:", error.message);
            return res.send(`<Response><Message>⚠️ Failed to initialize user profile. Please try again.</Message></Response>`);
        }
    }

    const contractorName = userProfile.name || 'Your Company Name';

    try {
        // ONBOARDING FLOW
if (userProfile.onboarding_in_progress) {
    let state = await getOnboardingState(from);
    if (!state) {
        state = { 
            step: 0, 
            responses: {}, 
            detectedLocation: detectCountryAndRegion(from), 
            locationConfirmed: false,
            awaitingLocationResponse: false,
            editMode: false
        };
        await setOnboardingState(from, state);
        return res.send(`<Response><Message>Welcome! What's your name?</Message></Response>`);
    }

    const response = body.trim();
    const responseLower = response.toLowerCase();

    // Step 0: Collect user's name
    if (state.step === 0) {
        state.responses.step_0 = response;
        state.step = 1; // Move to location confirmation
        await setOnboardingState(from, state);

        const { country, region } = state.detectedLocation;
        if (country !== "Unknown" && region !== "Unknown") {
            state.awaitingLocationResponse = true;
            await setOnboardingState(from, state);
            const sent = await sendTemplateMessage(
                from,
                confirmationTemplates.locationConfirmation,
                [
                    { type: "text", text: country },
                    { type: "text", text: region }
                ]
            );
            if (sent) {
                console.log(`[DEBUG] Sent location confirmation template to ${from}`);
                return res.send(`<Response></Response>`);
            } else {
                console.error("[ERROR] Failed to send location confirmation template, falling back to manual input");
                state.awaitingLocationResponse = false;
                await setOnboardingState(from, state);
                return res.send(`<Response><Message>⚠️ Couldn’t detect your location automatically. Please enter your country.</Message></Response>`);
            }
        } else {
            state.awaitingLocationResponse = false;
            await setOnboardingState(from, state);
            return res.send(`<Response><Message>Please enter your country.</Message></Response>`);
        }
    }

    // Handle response to location confirmation (Step 1) when awaiting a reply
    if (state.step === 1 && state.awaitingLocationResponse) {
        const buttonResponse = req.body.ButtonText || response; // Use ButtonText for quick replies
        const buttonResponseLower = buttonResponse.toLowerCase();
        if (buttonResponseLower === "yes") {
            state.responses.step_1 = state.detectedLocation.country;
            state.responses.step_2 = state.detectedLocation.region;
            state.locationConfirmed = true;
            state.awaitingLocationResponse = false;
            state.step = 4; // Skip to business type
            await setOnboardingState(from, state);
            const nextQuestion = onboardingSteps[state.step] || "Please continue with the next step.";
            if (onboardingTemplates.hasOwnProperty(state.step)) {
                const sent = await sendTemplateMessage(from, onboardingTemplates[state.step], {});
                if (!sent) return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
                return res.send(`<Response></Response>`);
            }
            return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
        } else if (buttonResponseLower === "edit" || buttonResponseLower === "cancel") {
            state.locationConfirmed = false;
            state.awaitingLocationResponse = false;
            state.editMode = true;
            state.step = 1; // Stay at step 1 for manual input
            await setOnboardingState(from, state);
            console.log(`[DEBUG] User opted to edit location. Advancing to manual country input.`);
            return res.send(`<Response><Message>Please enter your country:</Message></Response>`);
        } else {
            console.log(`[DEBUG] Invalid response to location confirmation: ${buttonResponse}`);
            return res.send(`<Response><Message>⚠️ Please reply with 'Yes', 'Edit', or 'Cancel'.</Message></Response>`);
        }
    }

    // Handle manual location input in edit mode
    if (state.editMode && state.step === 1) {
        state.responses.step_1 = response;
        state.editMode = false;
        state.step = 2; // Move to state/province input
        await setOnboardingState(from, state);
        return res.send(`<Response><Message>Please enter your state or province:</Message></Response>`);
    }
    if (state.editMode && state.step === 2) {
        state.responses.step_2 = response;
        state.editMode = false;
        state.step = 4; // Proceed to business type
        await setOnboardingState(from, state);
        const nextQuestion = onboardingSteps[state.step] || "Please continue with the next step.";
        if (onboardingTemplates.hasOwnProperty(state.step)) {
            const sent = await sendTemplateMessage(from, onboardingTemplates[state.step], {});
            if (!sent) return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
            return res.send(`<Response></Response>`);
        }
        return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
    }

    // Continue with regular onboarding steps (steps 4 and onward)
    if (state.step >= 4) {
        const buttonResponse = req.body.ButtonText || response; // Handle quick reply buttons
        const buttonResponseLower = buttonResponse.toLowerCase();

        // Store the response for the current step and increment step
        state.responses[`step_${state.step}`] = buttonResponse;
        console.log(`[DEBUG] Recorded response for step ${state.step}:`, buttonResponse);

        // Define step-specific logic before incrementing
        if (state.step === 9 && buttonResponseLower === "yes") {
            state.step = 10; // Move to bills question
        } else if (state.step === 9) {
            state.step = 11; // Skip bills if "No"
        } else if (state.step === 10 && buttonResponseLower === "yes") {
            state.step = 11; // Move to email after "Yes"
        } else if (state.step === 10 && buttonResponseLower === "no") {
            state.step = 11; // Move to email after "No"
        } else if (state.step === 12) { // "Do you need to send quotes?"
            state.step = buttonResponseLower === 'yes' ? 13 : 18; // Skip to end if "No"
        } else if (state.step === 14) { // Sales Tax Registration Number (optional)
            state.responses.step_14 = buttonResponseLower === 'skip' ? '' : buttonResponse;
            state.step = 15;
        } else if (state.step === 17) { // Logo upload
            if (buttonResponseLower === 'yes') {
                if (mediaUrl && mediaType.includes('image')) {
                    const logoResponse = await axios.get(mediaUrl, {
                        responseType: 'arraybuffer',
                        auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
                    });
                    const buffer = Buffer.from(logoResponse.data);
                    const fileName = `logos/${from}_${Date.now()}.jpg`;
                    const file = storage.bucket().file(fileName);
                    await file.save(buffer, { contentType: mediaType });
                    const [logoUrl] = await file.getSignedUrl({ action: 'read', expires: '03-05-2030' });
                    state.responses.step_17 = logoUrl;
                    state.step = 18; // Move to completion
                } else {
                    return res.send(`<Response><Message>Please send an image file with your logo.</Message></Response>`);
                }
            } else {
                state.responses.step_17 = ''; // No logo
                state.step = 18; // Move to completion
            }
        } else {
            state.step++; // Default increment for other steps
        }

        await setOnboardingState(from, state);

        // Handle next step or completion
        if (state.step < onboardingSteps.length) {
            const nextQuestion = onboardingSteps[state.step];
            console.log(`[DEBUG] Next question (step ${state.step}) for ${from}:`, nextQuestion);
            if (onboardingTemplates.hasOwnProperty(state.step)) {
                const sent = await sendTemplateMessage(from, onboardingTemplates[state.step], {});
                if (!sent) {
                    console.error("Falling back to plain text question because template message sending failed");
                    return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
                }
                return res.send(`<Response></Response>`);
            }
            return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
        } else {
            // Final step: complete onboarding
            const emailStep = state.locationConfirmed ? 11 : 10;
            const email = state.responses[`step_${emailStep}`];
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return res.send(`<Response><Message>⚠️ The email address you provided doesn't seem valid. Please enter a valid email address.</Message></Response>`);
            }

            let business_type, industry, personal_expenses_enabled, track_mileage, track_home_office, financial_goals, add_bills, needsQuotes;
            if (state.locationConfirmed) {
                business_type = state.responses.step_4;
                industry = state.responses.step_5;
                personal_expenses_enabled = state.responses.step_6.toLowerCase() === "yes";
                track_mileage = state.responses.step_7.toLowerCase() === "yes";
                track_home_office = state.responses.step_8.toLowerCase() === "yes";
                financial_goals = state.responses.step_9;
                add_bills = state.responses.step_10?.toLowerCase() === "yes";
                needsQuotes = state.responses.step_12?.toLowerCase() === "yes";
            } else {
                business_type = state.responses.step_3;
                industry = state.responses.step_4;
                personal_expenses_enabled = state.responses.step_5.toLowerCase() === "yes";
                track_mileage = state.responses.step_6.toLowerCase() === "yes";
                track_home_office = state.responses.step_7.toLowerCase() === "yes";
                financial_goals = state.responses.step_8;
                add_bills = state.responses.step_9?.toLowerCase() === "yes";
                needsQuotes = state.responses.step_12?.toLowerCase() === "yes";
            }

            try {
                const userProfileData = {
                    user_id: from,
                    name: state.responses.step_0 || 'Unknown User',
                    country: state.responses.step_1 || 'Unknown Country',
                    province: state.responses.step_2 || 'Unknown Province',
                    business_type: business_type || 'Sole Proprietorship',
                    industry: industry || 'Other',
                    personal_expenses_enabled: personal_expenses_enabled || false,
                    track_mileage: track_mileage || false,
                    track_home_office: track_home_office || false,
                    financial_goals: financial_goals || 'Save to invest',
                    add_bills: add_bills || false,
                    email: email || 'unknown@email.com',
                    needsQuotes: needsQuotes || false,
                    companyName: needsQuotes ? (state.responses.step_13 || '') : '',
                    hstNumber: needsQuotes ? (state.responses.step_14 || '') : '',
                    companyAddress: needsQuotes ? (state.responses.step_15 || '') : '',
                    companyPhone: needsQuotes ? (state.responses.step_16 || '') : '',
                    logoUrl: needsQuotes ? (state.responses.step_17 || '') : '',
                    paymentTerms: needsQuotes ? 'Due upon receipt' : '',
                    specialMessage: needsQuotes ? 'Thank you for your business!' : '',
                    created_at: userProfile.created_at,
                    onboarding_in_progress: false
                };
                console.log(`[DEBUG] Marking onboarding as complete for ${from}`);
                await saveUserProfile(userProfileData);
                const spreadsheetId = await createSpreadsheetForUser(from, userProfileData.email);
                await sendSpreadsheetEmail(userProfileData.email, spreadsheetId);
                console.log(`[DEBUG] Onboarding complete for ${from}:`, userProfileData);

                const sentLink = await sendTemplateMessage(
                    from,
                    confirmationTemplates.spreadsheetLink,
                    [
                        { type: "text", text: userProfileData.name },
                        { type: "text", text: spreadsheetId }
                    ]
                );
                if (!sentLink) {
                    console.error("Failed to send spreadsheet link template, falling back to plain text.");
                    const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
                    return res.send(`<Response><Message>✅ Onboarding complete, ${userProfileData.name}! Your spreadsheet is available at ${spreadsheetUrl}</Message></Response>`);
                }
                return res.send(`<Response></Response>`);
            } catch (error) {
                console.error("[ERROR] Failed to complete onboarding:", error);
                return res.send(`<Response><Message>⚠️ Sorry, something went wrong while completing your profile. Please try again later.</Message></Response>`);
            }
        }
    }
}

     // ─── NON-ONBOARDING FLOW (RETURNING USERS) ─────────────────────────
else {
    let reply;

    // Check for pending transactions in Firestore
    const pendingState = await getPendingTransactionState(from);

    // 0. Pending Quote Handling (process pending quote before other types)
    if (pendingState && pendingState.pendingQuote) {
        const { jobName, items, total, isFixedPrice, description } = pendingState.pendingQuote;
        const customerInput = body.trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const customerName = emailRegex.test(customerInput) ? 'Email Provided' : customerInput;
        const customerEmail = emailRegex.test(customerInput) ? customerInput : null;

        // Tax Configuration (markup is already in unit prices for itemized quotes)
        const taxRate = userProfile.taxRate || getTaxRate(userProfile.country, userProfile.province);
        const subtotal = total;
        const tax = subtotal * taxRate;
        const totalWithTax = subtotal + tax; // No separate markup multiplier here

        // Generate PDF quote document with custom settings
        const outputPath = `/tmp/quote_${from}_${Date.now()}.pdf`;
        const quoteData = {
            jobName,
            items: isFixedPrice ? [{ item: description, quantity: 1, price: subtotal }] : items,
            subtotal,
            tax,
            total: totalWithTax,
            customerName,
            contractorName: userProfile.name || 'Your Company Name',
            companyName: userProfile.companyName || '',
            hstNumber: userProfile.hstNumber || '',
            companyAddress: userProfile.companyAddress || '',
            companyPhone: userProfile.companyPhone || '',
            logoUrl: userProfile.logoUrl || '',
            paymentTerms: userProfile.paymentTerms || 'Due upon receipt',
            specialMessage: userProfile.specialMessage || 'Thank you for your business!'
        };
        await generateQuotePDF(quoteData, outputPath);

        // Upload PDF to Google Drive
        const auth = await getAuthorizedClient();
        const drive = google.drive({ version: 'v3', auth });
        const fileName = `Quote_${jobName}_${Date.now()}.pdf`;
        const fileMetadata = { name: fileName };
        const media = {
            mimeType: 'application/pdf',
            body: fs.createReadStream(outputPath),
        };
        const driveResponse = await drive.files.create({
            resource: fileMetadata,
            media,
            fields: 'id, webViewLink',
        });
        await drive.permissions.create({
            fileId: driveResponse.data.id,
            requestBody: { role: 'reader', type: 'anyone' },
        });
        const pdfUrl = driveResponse.data.webViewLink;

        // Clear pending quote state
        await deletePendingTransactionState(from);

        // Send response with the PDF link (no markup mention)
        reply = `✅ Quote for ${jobName} generated.\nSubtotal: $${subtotal.toFixed(2)}\nTax (${(taxRate * 100).toFixed(2)}%): $${tax.toFixed(2)}\nTotal: $${totalWithTax.toFixed(2)}\nCustomer: ${customerName}\nDownload here: ${pdfUrl}`;
        if (customerEmail) {
            await sendSpreadsheetEmail(customerEmail, driveResponse.data.id, 'Your Quote');
            reply += `\nAlso sent to ${customerEmail}`;
        }
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // 1. Chief Message Handling
    else if (body.toLowerCase() === "chief!!") {
        await setPendingTransactionState(from, { pendingChiefMessage: true });
        return res.send(`<Response><Message>Please write your message for Scott, and I'll send it to him!</Message></Response>`);
    }
    else if (pendingState && pendingState.pendingChiefMessage) {
        const userMessage = body.trim();
        const senderName = userProfile.name || 'Unknown User';
        const senderPhone = from;

        try {
            await sendEmail({
                to: 'scottejutras@gmail.com',
                from: 'scott@scottjutras.com', // Matches your verified sender
                subject: `Message from ${senderName} (${senderPhone})`,
                text: `From: ${senderName} (${senderPhone})\n\nMessage:\n${userMessage}`
            });
            await deletePendingTransactionState(from);
            return res.send(`<Response><Message>✅ Your message has been sent to Scott! He'll get back to you soon.</Message></Response>`);
        } catch (error) {
            console.error('[ERROR] Failed to send Chief message:', error);
            await deletePendingTransactionState(from);
            return res.send(`<Response><Message>⚠️ Sorry, something went wrong sending your message. Please try again later.</Message></Response>`);
        }
    }

    // 2. Pending Confirmations for Expense, Revenue, or Bill (existing logic)
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
            await setPendingTransactionState(from, { isEditing: true });
            await deletePendingTransactionState(from);
            return res.send(`<Response><Message>${reply}</Message></Response>`);
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
            }
            return res.send(`<Response><Message>${reply}</Message></Response>`);
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
            confirmationTemplates.startJob, // Use the correct SID from confirmationTemplates
            [{ type: "text", text: jobName }]
        );
        if (sent) {
            return res.send(`<Response><Message>✅ Quick Reply Sent. Please confirm the job.</Message></Response>`);
        } else {
            return res.send(`<Response><Message>✅ Job '${jobName}' started, but confirmation failed. It’s still active!</Message></Response>`);
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
                    body.toLowerCase().includes("I made") ||
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
else if (body && /^(finish job|job finish)\s+(.+)/i.test(body)) {
    const jobName = body.match(/^(finish job|job finish)\s+(.+)/i)[2].trim();
    await finishJob(from, jobName);
    return res.send(`<Response><Message>✅ Job '${jobName}' finished.</Message></Response>`);
}

// 5. Metrics Queries
else if (body && (body.toLowerCase().includes("how much") || 
                  body.toLowerCase().includes("profit") || 
                  body.toLowerCase().includes("margin") || 
                  body.toLowerCase().includes("spend") || 
                  body.toLowerCase().includes("spent") || 
                  (body.toLowerCase().includes("how about") && (await getLastQuery(from))?.intent))) {
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
    if ((body.toLowerCase().includes("revenue") || (body.toLowerCase().includes("how much") && body.toLowerCase().includes("make") && body.toLowerCase().includes("on"))) && /\d+\s+[a-zA-Z]+/.test(body)) {
        const jobName = body.match(/(?:job|on)\s+([\w\s]+)/i)?.[1]?.trim() || activeJob;
        const jobRevenues = revenues.filter(row => row[1] === jobName || row[3] === jobName); // Check Source or Category
        const totalRevenue = jobRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        await setLastQuery(from, { intent: "revenue", timestamp: new Date().toISOString() });
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

    if (body.toLowerCase().includes("how much") && body.toLowerCase().includes("make") && body.toLowerCase().includes("on") && /\d+\s+[a-zA-Z]+/.test(body)) {
        const jobName = body.match(/on\s+([\w\s]+)/i)?.[1]?.trim() || activeJob;
        const jobRevenues = revenues.filter(row => row[1] === jobName);
        const totalRevenue = jobRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
        await setLastQuery(from, { intent: "revenue", timestamp: new Date().toISOString() });
        return res.send(`<Response><Message>You made $${totalRevenue.toFixed(2)} in revenue on Job ${jobName}.</Message></Response>`);
    }

    // AI Fallback
    console.log("[DEBUG] No exact match found, falling back to AI interpretation...");
    try {
        const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const lastQuery = await getLastQuery(from);
        const contextMessage = lastQuery && (new Date().getTime() - new Date(lastQuery.timestamp).getTime()) < 5 * 60 * 1000
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
            return res.send(`<Response><Message>${aiResult.response || "I’m here to help..."}</Message></Response>`);
        } else if (aiResult.intent === "profit" && aiResult.job) {
            const jobName = aiResult.job;
            const jobExpenses = expenses.filter(row => row[4] === jobName);
            const jobRevenues = revenues.filter(row => row[1] === jobName || row[3] === jobName);
            const totalExpenses = jobExpenses.reduce((sum, row) => sum + parseAmount(row[2]), 0);
            const totalRevenue = jobRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
            const profit = totalRevenue - totalExpenses;
            await setLastQuery(from, { intent: "profit", timestamp: new Date().toISOString() });
            return res.send(`<Response><Message>Profit for Job ${jobName} is $${profit.toFixed(2)} (Revenue: $${totalRevenue.toFixed(2)}, Expenses: $${Math.abs(totalExpenses).toFixed(2)}).</Message></Response>`);
        } else if (aiResult.intent === "revenue" && aiResult.job) {
            const jobName = aiResult.job;
            const jobRevenues = revenues.filter(row => row[1] === jobName || row[3] === jobName);
            const totalRevenue = jobRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
            await setLastQuery(from, { intent: "revenue", timestamp: new Date().toISOString() });
            return res.send(`<Response><Message>You made $${totalRevenue.toFixed(2)} in revenue on Job ${jobName}.</Message></Response>`);
        } else if (aiResult.intent === "unknown") {
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
// 7. Quote Handling with Enhancements
else if (body.toLowerCase().startsWith("quote")) {
    console.log('[DEBUG] Detected quote request:', body);
    const pendingState = await getPendingTransactionState(from);

    // Handle pending quote (customer details submission)
    if (pendingState && pendingState.pendingQuote) {
        const { jobName, items, total, isFixedPrice, description } = pendingState.pendingQuote;
        const customerInput = body.trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const customerName = emailRegex.test(customerInput) ? 'Email Provided' : customerInput;
        const customerEmail = emailRegex.test(customerInput) ? customerInput : null;

        const taxRate = userProfile.taxRate || getTaxRate(userProfile.country, userProfile.province);
        const subtotal = total;
        const tax = subtotal * taxRate;
        const totalWithTax = isFixedPrice ? subtotal + tax : subtotal + tax; // No additional markup here; already in unit prices

        const outputPath = `/tmp/quote_${from}_${Date.now()}.pdf`;
        const quoteData = {
            jobName,
            items: isFixedPrice ? [{ item: description, quantity: 1, price: subtotal }] : items,
            subtotal,
            tax,
            total: totalWithTax,
            customerName,
            contractorName: userProfile.name || 'Your Company Name',
            companyName: userProfile.companyName,
            companyAddress: userProfile.companyAddress,
            companyPhone: userProfile.companyPhone,
            logoUrl: userProfile.logoUrl
        };
        await generateQuotePDF(quoteData, outputPath);

        const auth = await getAuthorizedClient();
        const drive = google.drive({ version: 'v3', auth });
        const fileName = `Quote_${jobName}_${Date.now()}.pdf`;
        const fileMetadata = { name: fileName };
        const media = { mimeType: 'application/pdf', body: fs.createReadStream(outputPath) };
        const driveResponse = await drive.files.create({
            resource: fileMetadata,
            media,
            fields: 'id, webViewLink',
        });
        await drive.permissions.create({
            fileId: driveResponse.data.id,
            requestBody: { role: 'reader', type: 'anyone' },
        });
        const pdfUrl = driveResponse.data.webViewLink;

        await deletePendingTransactionState(from);

        let reply = `✅ Quote for ${jobName} generated.\nSubtotal: $${subtotal.toFixed(2)}\nTax (${(taxRate * 100).toFixed(2)}%): $${tax.toFixed(2)}\nTotal: $${totalWithTax.toFixed(2)}\nCustomer: ${customerName}\nDownload here: ${pdfUrl}`;
        if (customerEmail) {
            await sendSpreadsheetEmail(customerEmail, driveResponse.data.id, 'Your Quote');
            reply += `\nAlso sent to ${customerEmail}`;
        }
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Parse fixed-price quote (e.g., "Quote for 123 Happy St: 675 for siding")
    const fixedPriceMatch = body.match(/quote for\s+([^:]+):\s*(\d+(?:\.\d{1,2})?)\s+for\s+(.+)/i);
    if (fixedPriceMatch) {
        const jobName = fixedPriceMatch[1].trim();
        const subtotal = parseFloat(fixedPriceMatch[2]);
        const description = fixedPriceMatch[3].trim();
        console.log('[DEBUG] Detected fixed-price quote:', { jobName, subtotal, description });

        const taxRate = userProfile.taxRate || getTaxRate(userProfile.country, userProfile.province);
        const tax = subtotal * taxRate;

        await setPendingTransactionState(from, {
            pendingQuote: { jobName, items: [], total: subtotal, isFixedPrice: true, description }
        });
        return res.send(`<Response><Message>✅ Quote calculated: $${subtotal.toFixed(2)} (subtotal) + ${(taxRate * 100).toFixed(2)}% tax ($${tax.toFixed(2)}) for ${description}. Please provide the customer’s name or email to finalize.</Message></Response>`);
    }

    // Itemized quote parsing with custom items and markup
    const quoteMatch = body.match(/quote for\s+([^:]+)(?::\s*(.+))?/i);
    console.log('[DEBUG] Quote match result:', quoteMatch);

    if (!quoteMatch) {
        return res.send(`<Response><Message>⚠️ Please provide a job name and items, e.g., 'Quote for Job 75: 10 nails, $50 for paint' or 'Quote for 123 Happy St: 675 for siding'</Message></Response>`);
    }

    const jobName = quoteMatch[1].trim();
    const itemsText = quoteMatch[2] ? quoteMatch[2].trim() : null;
    console.log('[DEBUG] Parsed jobName:', jobName, 'itemsText:', itemsText);

    if (!itemsText) {
        return res.send(`<Response><Message>⚠️ Please list items or a total amount for the quote after a colon, e.g., '10 nails plus 40%, $50 for paint' or '675 for siding'</Message></Response>`);
    }

    // Check for overall markup (e.g., "plus 40%" at the end)
    const overallMarkupMatch = itemsText.match(/plus\s+(\d+)%$/i);
    const overallMarkup = overallMarkupMatch ? (1 + parseInt(overallMarkupMatch[1]) / 100) : 1.40; // Default 40% if not specified
    const itemsTextWithoutMarkup = overallMarkupMatch ? itemsText.replace(overallMarkupMatch[0], '').trim() : itemsText;

    const itemList = itemsTextWithoutMarkup.split(',').map(item => item.trim());
    const items = [];
    for (const itemEntry of itemList) {
        // Custom item with price (e.g., "$50 for custom paint")
        const customMatch = itemEntry.match(/\$(\d+(?:\.\d{1,2})?)\s+for\s+(.+)/i);
        if (customMatch) {
            const price = parseFloat(customMatch[1]);
            const item = customMatch[2].trim();
            items.push({ quantity: 1, item, price });
            console.log('[DEBUG] Parsed custom item:', { quantity: 1, item, price });
        } else {
            // Spreadsheet item with optional per-item markup (e.g., "10 windows plus 40%")
            const match = itemEntry.match(/(\d+)\s+(.+?)(?:\s+plus\s+(\d+)%|$)/i);
            if (match) {
                const quantity = parseInt(match[1], 10);
                const item = match[2].trim();
                const itemMarkup = match[3] ? (1 + parseInt(match[3]) / 100) : overallMarkup; // Use item-specific or overall markup
                items.push({ quantity, item, markup: itemMarkup });
                console.log('[DEBUG] Parsed spreadsheet item:', { quantity, item, markup: itemMarkup });
            }
        }
    }
    console.log('[DEBUG] Parsed items:', items);

    if (!items.length) {
        return res.send(`<Response><Message>⚠️ Couldn’t parse items. Use format: '10 nails plus 40%, $50 for paint' or '675 for siding'</Message></Response>`);
    }

    const pricingSpreadsheetId = process.env.PRICING_SPREADSHEET_ID;
    if (!pricingSpreadsheetId) {
        console.error('[ERROR] PRICING_SPREADSHEET_ID not set in environment variables.');
        return res.send(`<Response><Message>⚠️ Pricing spreadsheet not configured. Contact support.</Message></Response>`);
    }
    const priceMap = await fetchMaterialPrices(pricingSpreadsheetId);
    console.log('[DEBUG] Price map fetched:', priceMap);

    let total = 0;
    const quoteItems = [];
    const missingItems = [];
    items.forEach(({ item, quantity, price, markup }) => {
        if (price !== undefined) {
            // Custom item with user-specified price (no markup applied here)
            const lineTotal = price * quantity;
            total += lineTotal;
            quoteItems.push({ item, quantity, price });
        } else {
            // Spreadsheet item with markup integrated into unit price
            let normalizedItem = item.toLowerCase().replace(/\s+/g, ' ').trim();
            if (normalizedItem === "windows labour hours" || normalizedItem === "window labour hours") {
                normalizedItem = "window labour";
            }
            const basePrice = priceMap[normalizedItem];
            console.log('[DEBUG] Checking price for:', normalizedItem, 'Base price:', basePrice);
            if (basePrice !== undefined && basePrice > 0) {
                const markedUpPrice = basePrice * (markup || 1.40); // Apply markup (default 40% if not specified)
                const lineTotal = markedUpPrice * quantity;
                total += lineTotal;
                quoteItems.push({ item, quantity, price: markedUpPrice });
                console.log('[DEBUG] Applied markup:', { item, basePrice, markedUpPrice, markup });
            } else {
                missingItems.push(item);
            }
        }
    });

    console.log('[DEBUG] Quote items:', quoteItems, 'Total:', total, 'Missing items:', missingItems);

    if (!quoteItems.length) {
        return res.send(`<Response><Message>⚠️ No valid prices found for items: ${itemsText}. Check your pricing sheet: https://docs.google.com/spreadsheets/d/${pricingSpreadsheetId}</Message></Response>`);
    }

    await setPendingTransactionState(from, { pendingQuote: { jobName, items: quoteItems, total, isFixedPrice: false } });
    let reply = `✅ Quote calculated: $${total.toFixed(2)} (subtotal). Please provide the customer’s name or email to finalize.`;
    if (missingItems.length) {
        reply += `\n⚠️ Missing prices for: ${missingItems.join(', ')}.`;
    }
    return res.send(`<Response><Message>${reply}</Message></Response>`);
}
      // 8. Text Expense Logging (Updated to Handle Edit Directly)
      else if (body) {
        try {
            console.log("[DEBUG] Attempting to parse message:", body);
            const activeJob = (await getActiveJob(from)) || "Uncategorized";
            const pendingState = await getPendingTransactionState(from);
            const subscriptionTier = await getSubscriptionTier(from);
            let data, type;
    
            // Determine if expense or revenue
            if (body.toLowerCase().includes('revenue') || body.toLowerCase().includes('earned')) {
                type = 'revenue';
                data = parseRevenueMessage(body);
            } else {
                type = 'expense';
                data = parseExpenseMessage(body);
            }
    
            // Skip if too vague
            if (body.length < 3 || (!body.includes("$") && !body.match(/\d+/))) {
                return res.send(`<Response><Message>⚠️ I didn’t understand '${body}'. Try '$50 for nails from Home Depot' or 'Revenue $1000 from John Doe'.</Message></Response>`);
            }
    
            // Handle pending corrections or edits
            if (pendingState && (pendingState.isEditing || pendingState.pendingCorrection)) {
                if (pendingState.pendingCorrection && body.toLowerCase() === 'yes') {
                    data = { ...pendingState.pendingData, ...pendingState.suggestedCorrections };
                    await deletePendingTransactionState(from);
                    await appendToUserSpreadsheet(from, type === 'expense' ? [
                        data.date, data.item, data.amount, data.store, activeJob, 'expense', data.suggestedCategory || "General"
                    ] : [
                        data.date, data.description, data.amount, data.client, activeJob, 'revenue', "Income"
                    ]);
                    return res.send(`<Response><Message>✅ Corrected ${type} logged: ${data.amount} ${type === 'expense' ? `for ${data.item} from ${data.store}` : `from ${data.client}`}</Message></Response>`);
                } else if (body.toLowerCase() === 'no') {
                    await deletePendingTransactionState(from); // Clear old state first
                    await setPendingTransactionState(from, { isEditing: true, type });
                    return res.send(`<Response><Message>✏️ Okay, please provide the correct ${type} details.</Message></Response>`);
                } else {
                    data = type === 'expense' ? parseExpenseMessage(body) : parseRevenueMessage(body);
                    if (data && Object.keys(data).length > 0) {
                        await deletePendingTransactionState(from);
                    } else {
                        return res.send(`<Response><Message>⚠️ Could not understand your edited ${type}. Try again.</Message></Response>`);
                    }
                }
            }
    
            // Initial parsing with AI fallback for paid tiers
            if (!data || Object.keys(data).length === 0) {
                data = type === 'expense' ? parseExpenseMessage(body) : parseRevenueMessage(body);
                if ((!data || Object.keys(data).length === 0) && subscriptionTier !== 'free') {
                    const hasTokens = await checkTokenLimit(from, subscriptionTier);
                    if (!hasTokens && subscriptionTier !== 'pro') {
                        return res.send(`<Response><Message>⚠️ You've exceeded your AI token limit. Purchase more tokens for $0.01/1000 or upgrade your plan!</Message></Response>`);
                    }
                    try {
                        const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                        const gptResponse = await openaiClient.chat.completions.create({
                            model: "gpt-3.5-turbo",
                            messages: [
                                { role: "system", content: `Extract structured ${type} data from the following text. Return JSON with keys: ${type === 'expense' ? 'date, item, amount, store' : 'date, description, amount, client'}. If no data, return '{}'.` },
                                { role: "user", content: `Text: "${body.trim()}"` }
                            ],
                            max_tokens: 60,
                            temperature: 0.3
                        });
                        data = JSON.parse(gptResponse.choices[0].message.content);
                        await updateUserTokenUsage(from, gptResponse.usage.total_tokens);
                        if (Object.keys(data).length === 0) {
                            return res.send(`<Response><Message>⚠️ Could not parse '${body}' as ${type}. Try again.</Message></Response>`);
                        }
                    } catch (error) {
                        console.error(`[ERROR] GPT-3.5 ${type} parsing failed:`, error.message);
                    }
                }
                if (!data || Object.keys(data).length === 0) {
                    return res.send(`<Response><Message>⚠️ Could not parse '${body}' as ${type}. Try again.</Message></Response>`);
                }
            }
    
            if (data && data.amount && data.amount !== "$0.00") {
                if (!data.date) data.date = new Date().toISOString().split('T')[0];
                data.amount = `$${parseFloat(data.amount.replace(/[^0-9.]/g, '')).toFixed(2)}`;
    
                // Normalize data
                if (type === 'expense') {
                    const storeLower = data.store?.toLowerCase().replace(/\s+/g, '');
                    data.store = storeList.find(s => s.toLowerCase().replace(/\s+/g, '') === storeLower) || data.store;
                    data.suggestedCategory = storeList.includes(data.store) ? "Construction Materials" : "General";
                } else if (type === 'revenue') {
                    data.description = data.description || "Payment";
                    data.client = data.client || "Unknown Client";
                }
    
                // Error Detection & Correction
                const errors = detectErrors(data, type);
                if (errors && subscriptionTier !== 'free') {
                    const hasTokens = await checkTokenLimit(from, subscriptionTier);
                    if (!hasTokens && subscriptionTier !== 'pro') {
                        return res.send(`<Response><Message>⚠️ You've exceeded your AI token limit. Purchase more tokens for $0.01/1000 or upgrade your plan!</Message></Response>`);
                    }
                    const { corrections, tokensUsed } = await suggestCorrections(data, errors, body, type);
                    if (corrections) {
                        await updateUserTokenUsage(from, tokensUsed);
                        await setPendingTransactionState(from, {
                            pendingData: data,
                            pendingCorrection: true,
                            suggestedCorrections: corrections,
                            type
                        });
                        const correctionText = Object.entries(corrections)
                            .map(([key, value]) => `${key}: ${data[key]} → ${value}`)
                            .join('\n');
                        return res.send(`<Response><Message>🤔 Detected issues in ${type}:\n${correctionText}\nReply 'yes' to accept or 'no' to edit manually.</Message></Response>`);
                    }
                } else if (errors) {
                    const errorText = errors.map(e => `${e.field}: ${e.message}`).join('\n');
                    await setPendingTransactionState(from, { pendingData: data, isEditing: true, type });
                    return res.send(`<Response><Message>⚠️ Issues detected in ${type}:\n${errorText}\nPlease resend with corrections.</Message></Response>`);
                }
    
                // No errors: Confirm and log
                await setPendingTransactionState(from, { pendingData: data, type });
                const template = type === 'expense' ? confirmationTemplates.expense : confirmationTemplates.revenue;
                const sent = await sendTemplateMessage(
                    from,
                    template,
                    { "1": `${type === 'expense' ? `Expense of ${data.amount} for ${data.item} from ${data.store}` : `Revenue of ${data.amount} from ${data.client}`} on ${data.date}` }
                );
                if (sent) {
                    return res.send(`<Response></Response>`);
                } else {
                    return res.send(`<Response><Message>⚠️ Failed to send ${type} confirmation. Try again.</Message></Response>`);
                }
            } else {
                return res.send(`<Response><Message>⚠️ Could not understand your ${type} message. Try again.</Message></Response>`);
            }
        } catch (error) {
            console.error("[ERROR] Processing webhook request failed:", error);
            return res.send(`<Response><Message>⚠️ Internal Server Error. Please try again.</Message></Response>`);
        }
    }
}
    // Default response for unhandled messages
reply = "⚠️ Sorry, I didn't understand that. Please provide an expense, revenue, or job command.";
return res.send(`<Response><Message>${reply}</Message></Response>`);
} catch (error) {
    console.error("[ERROR] Webhook processing failed:", error);
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
    await setActiveJob(from, jobName); // Uses top-level version
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

// GET Route for Server Verification
app.get('/', (req, res) => {
    console.log("[DEBUG] GET request received at root URL.");
    res.send("Webhook server is up and running!");
});

// Start Express Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`[DEBUG] Webhook server running at http://localhost:${PORT}`);
});

// Debugging environment variables and initializing Google Vision credentials
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