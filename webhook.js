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

// Onboarding Steps & State
const onboardingSteps = [
    "Can I get your name?",
    "We detected your location as {{detectedLocation.country}}, {{detectedLocation.region}}. Is this correct? (Yes/No)",
    "Please enter your country if different:",
    "Please enter your province or state if different:",
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

    // Step 0: Collect user's name
    if (state.step === 0) {
        state.responses.step_0 = body.trim();
        state.step = 1; // Move to location confirmation
        await setOnboardingState(from, state);

        const { country, region } = state.detectedLocation;
        // If we have a valid detected location, send the confirmation template
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
            // If location detection failed, prompt for manual country input
            state.awaitingLocationResponse = false;
            await setOnboardingState(from, state);
            return res.send(`<Response><Message>Please enter your country.</Message></Response>`);
        }
    }

    // Handle response to location confirmation (Step 1) when awaiting a reply
    if (state.step === 1 && state.awaitingLocationResponse) {
        const response = req.body.ButtonText || body; // Use ButtonText if available from Twilio's quick reply
        const responseLower = response.toLowerCase();
        if (responseLower === "yes") {
            // User confirms detected location: auto-fill country and region
            state.responses.step_1 = state.detectedLocation.country;
            state.responses.step_2 = state.detectedLocation.region;
            state.locationConfirmed = true;
            state.awaitingLocationResponse = false;
            state.step = 4; // Skip manual country/state input and proceed to business type (step 4)
            await setOnboardingState(from, state);
            const nextQuestion = onboardingSteps[state.step] || "Please continue with the next step.";
            console.log(`[DEBUG] Location confirmed. Moving to step ${state.step}.`);
            // Send quick reply template for step 4 if available
            if (onboardingTemplates.hasOwnProperty(state.step)) {
                const sent = await sendTemplateMessage(from, onboardingTemplates[state.step], {});
                if (!sent) {
                    return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
                }
                return res.send(`<Response></Response>`);
            } else {
                return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
            }
        } else if (responseLower === "edit" || responseLower === "cancel") {
            // User wants to manually enter location details
            state.locationConfirmed = false;
            state.awaitingLocationResponse = false;
            state.editMode = true;
            state.step = 1; // Remain at step 1 for manual country input
            await setOnboardingState(from, state);
            console.log(`[DEBUG] User opted to edit location. Advancing to manual country input.`);
            return res.send(`<Response><Message>Please enter your country:</Message></Response>`);
        } else {
            console.log(`[DEBUG] Invalid response to location confirmation: ${response}`);
            return res.send(`<Response><Message>⚠️ Please reply with 'Yes', 'Edit', or 'Cancel'.</Message></Response>`);
        }
    }

    // Handle manual location input in edit mode
    if (state.editMode && state.step === 1) {
        // Manual input for country
        state.responses.step_1 = body.trim();
        state.editMode = false; // Reset edit flag
        state.step = 2; // Move to state/province input
        await setOnboardingState(from, state);
        return res.send(`<Response><Message>Please enter your state or province:</Message></Response>`);
    }
    if (state.editMode && state.step === 2) {
        // Manual input for state/province
        state.responses.step_2 = body.trim();
        state.editMode = false;
        state.step = 4; // Proceed to business type question
        await setOnboardingState(from, state);
        const nextQuestion = onboardingSteps[state.step] || "Please continue with the next step.";
        // Send quick reply for step 4 if available
        if (onboardingTemplates.hasOwnProperty(state.step)) {
            const sent = await sendTemplateMessage(from, onboardingTemplates[state.step], {});
            if (!sent) {
                return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
            }
            return res.send(`<Response></Response>`);
        } else {
            return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
        }
    }

    // Continue with regular onboarding steps (steps 4 and onward)
    if (state.step >= 4 && state.step < onboardingSteps.length) {
        state.responses[`step_${state.step}`] = body.trim();
        console.log(`[DEBUG] Recorded response for step ${state.step}:`, body);
        state.step++;
        await setOnboardingState(from, state);
        if (state.step === 10 && state.responses.step_9 && 
            (state.responses.step_9.toLowerCase() === "yes" || state.responses.step_9.toLowerCase() === "no")) {
            state.step = 11;
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
            // Final step: email collection and profile creation
            if (state.step >= onboardingSteps.length) {
                const emailStep = state.locationConfirmed ? 11 : 10;
                const email = state.responses[`step_${emailStep}`];
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(email)) {
                    return res.send(`<Response><Message>⚠️ The email address you provided doesn't seem valid. Please enter a valid email address.</Message></Response>`);
                }
            
                let business_type, industry, personal_expenses_enabled, track_mileage, track_home_office, financial_goals, add_bills;
                if (state.locationConfirmed) {
                    business_type = state.responses.step_4;
                    industry = state.responses.step_5;
                    personal_expenses_enabled = state.responses.step_6.toLowerCase() === "yes";
                    track_mileage = state.responses.step_7.toLowerCase() === "yes";
                    track_home_office = state.responses.step_8.toLowerCase() === "yes";
                    financial_goals = state.responses.step_9;
                    add_bills = state.responses.step_10?.toLowerCase() === "yes";
                } else {
                    business_type = state.responses.step_3;
                    industry = state.responses.step_4;
                    personal_expenses_enabled = state.responses.step_5.toLowerCase() === "yes";
                    track_mileage = state.responses.step_6.toLowerCase() === "yes";
                    track_home_office = state.responses.step_7.toLowerCase() === "yes";
                    financial_goals = state.responses.step_8;
                    add_bills = state.responses.step_9?.toLowerCase() === "yes";
                }
            
                try {
                    const userProfileData = {
                        user_id: from,
                        name: state.responses.step_0,
                        country: state.responses.step_1,
                        province: state.responses.step_2,
                        business_type: business_type,
                        industry: industry,
                        personal_expenses_enabled: personal_expenses_enabled,
                        track_mileage: track_mileage,
                        track_home_office: track_home_office,
                        financial_goals: financial_goals,
                        add_bills: add_bills,
                        email: email,
                        created_at: userProfile.created_at,
                        onboarding_in_progress: false
                    };
                    await saveUserProfile(userProfileData);
                    const spreadsheetId = await createSpreadsheetForUser(from, userProfileData.email);
                    await sendSpreadsheetEmail(userProfileData.email, spreadsheetId);
                    
                    await deleteOnboardingState(from);
                    console.log(`[DEBUG] Onboarding complete for ${from}:`, userProfileData);
                    
                    const sentLink = await sendTemplateMessage(
                        from,
                        confirmationTemplates.spreadsheetLink, // Fixed case
                        [
                            { type: "text", text: userProfileData.name }, // {{1}}
                            { type: "text", text: spreadsheetId }         // {{2}}
                        ]
                    );
                    if (!sentLink) {
                        console.error("Failed to send spreadsheet link template, falling back to plain text.");
                        const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
                        return res.send(`<Response><Message>✅ Onboarding complete, ${userProfileData.name}! Your spreadsheet is available at ${spreadsheetUrl}</Message></Response>`);
                    }
                    return res.send(`<Response></Response>`); // Template handles the response
                } catch (error) {
                    console.error("[ERROR] Failed to complete onboarding:", error);
                    return res.send(`<Response><Message>⚠️ Sorry, something went wrong while completing your profile. Please try again later.</Message></Response>`);
                }
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
      const { jobName, items, total } = pendingState.pendingQuote;
      const customerInput = body.trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const customerName = emailRegex.test(customerInput) ? 'Email Provided' : customerInput;
      const customerEmail = emailRegex.test(customerInput) ? customerInput : null;
  
      // Tax and Markup Configuration
      const taxRate = userProfile.taxRate || 0.13; // 13% default
      const markup = 1.20; // 20% profit margin
      const subtotal = total;
      const tax = subtotal * taxRate;
      const totalWithTaxAndMarkup = (subtotal + tax) * markup;
  
      // Generate PDF quote document
      const outputPath = `/tmp/quote_${from}_${Date.now()}.pdf`;
      const quoteData = {
        jobName,
        items,
        subtotal,
        tax,
        total: totalWithTaxAndMarkup,
        customerName,
        contractorName,
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
  
      // Send response with the PDF link (and email if provided)
      reply = `✅ Quote for ${jobName} generated.\nSubtotal: $${subtotal.toFixed(2)}\nTax (${(taxRate * 100)}%): $${tax.toFixed(2)}\nTotal (with 20% markup): $${totalWithTaxAndMarkup.toFixed(2)}\nCustomer: ${customerName}\nDownload here: ${pdfUrl}`;
      if (customerEmail) {
        await sendSpreadsheetEmail(customerEmail, driveResponse.data.id, 'Your Quote');
        reply += `\nAlso sent to ${customerEmail}`;
      }
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
  
    // 1. Pending Confirmations for Expense, Revenue, or Bill (existing logic)
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
        const markup = 1.40; // 40% markup for itemized quotes only, hidden from customer
        const subtotal = total;
        const tax = subtotal * taxRate;
        const totalWithTaxAndMarkup = isFixedPrice ? subtotal + tax : (subtotal + tax) * markup;

        const outputPath = `/tmp/quote_${from}_${Date.now()}.pdf`;
        const quoteData = {
            jobName,
            items: isFixedPrice ? [{ item: description, quantity: 1, price: subtotal }] : items,
            subtotal,
            tax,
            total: totalWithTaxAndMarkup,
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

        let reply = `✅ Quote for ${jobName} generated.\nSubtotal: $${subtotal.toFixed(2)}\nTax (${(taxRate * 100).toFixed(2)}%): $${tax.toFixed(2)}\nTotal: $${totalWithTaxAndMarkup.toFixed(2)}\nCustomer: ${customerName}\nDownload here: ${pdfUrl}`;
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

    // Itemized quote parsing with custom items
    const quoteMatch = body.match(/quote for\s+([^:]+)(?::\s*(.+))?/i);
    console.log('[DEBUG] Quote match result:', quoteMatch);

    if (!quoteMatch) {
        return res.send(`<Response><Message>⚠️ Please provide a job name and items, e.g., 'Quote for Job 75: 10 nails, $50 for paint' or 'Quote for 123 Happy St: 675 for siding'</Message></Response>`);
    }

    const jobName = quoteMatch[1].trim();
    const itemsText = quoteMatch[2] ? quoteMatch[2].trim() : null;
    console.log('[DEBUG] Parsed jobName:', jobName, 'itemsText:', itemsText);

    if (!itemsText) {
        return res.send(`<Response><Message>⚠️ Please list items or a total amount for the quote after a colon, e.g., '10 nails, $50 for paint' or '675 for siding'</Message></Response>`);
    }

    const itemList = itemsText.split(',').map(item => item.trim());
    const items = [];
    for (const itemEntry of itemList) {
        // Check for custom item with price (e.g., "$50 for custom paint")
        const customMatch = itemEntry.match(/\$(\d+(?:\.\d{1,2})?)\s+for\s+(.+)/i);
        if (customMatch) {
            const price = parseFloat(customMatch[1]);
            const item = customMatch[2].trim();
            items.push({ quantity: 1, item, price }); // Quantity 1 for custom items
            console.log('[DEBUG] Parsed custom item:', { quantity: 1, item, price });
        } else {
            // Standard item from spreadsheet (e.g., "10 windows")
            const match = itemEntry.match(/(\d+)\s+(.+)/i);
            if (match) {
                items.push({ quantity: parseInt(match[1], 10), item: match[2].trim() });
                console.log('[DEBUG] Parsed spreadsheet item:', { quantity: parseInt(match[1], 10), item: match[2].trim() });
            }
        }
    }
    console.log('[DEBUG] Parsed items:', items);

    if (!items.length) {
        return res.send(`<Response><Message>⚠️ Couldn’t parse items. Use format: '10 nails, $50 for paint' or '675 for siding'</Message></Response>`);
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
    items.forEach(({ item, quantity, price }) => {
        if (price !== undefined) {
            // Custom item with user-specified price
            const lineTotal = price * quantity;
            total += lineTotal;
            quoteItems.push({ item, quantity, price });
        } else {
            // Lookup price from spreadsheet
            let normalizedItem = item.toLowerCase().replace(/\s+/g, ' ').trim();
            if (normalizedItem === "windows labour hours" || normalizedItem === "window labour hours") {
                normalizedItem = "window labour";
            }
            const spreadsheetPrice = priceMap[normalizedItem];
            console.log('[DEBUG] Checking price for:', normalizedItem, 'Found:', spreadsheetPrice);
            if (spreadsheetPrice !== undefined && spreadsheetPrice > 0) {
                const lineTotal = spreadsheetPrice * quantity;
                total += lineTotal;
                quoteItems.push({ item, quantity, price: spreadsheetPrice });
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
    console.log("[DEBUG] Attempting to parse expense message:", body);
    const activeJob = (await getActiveJob(from)) || "Uncategorized";
    const pendingState = await getPendingTransactionState(from);
    let expenseData;

    // Skip parsing if body is too short or lacks expense-like structure
    if (body.length < 3 || (!body.includes("$") && !body.match(/\d+/))) {
        console.log("[DEBUG] Input too vague, likely not an expense:", body);
        return res.send(`<Response><Message>⚠️ I didn’t understand '${body}'. Try something like '$50 for nails from Home Depot' or ask a question!</Message></Response>`);
    }

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
                            content: "Extract structured expense data from the following text. Expect formats like 'Expense of $amount for item from store on date', '$amount for item at store on date', or 'Spent $amount on item from store on date'. Return a JSON string with keys: date, item, amount, store. If no expense data is present, return '{}'. Correct 'roof Mark' or 'roof Mart' to 'Roofmart'. If date is missing, use today's date." 
                        },
                        { role: "user", content: `Text: "${body.trim()}"` }
                    ],
                    max_tokens: 60,
                    temperature: 0.3
                });
                const responseText = gptResponse.choices[0].message.content.trim();
                try {
                    expenseData = JSON.parse(responseText);
                    if (Object.keys(expenseData).length === 0) {
                        return res.send(`<Response><Message>⚠️ Could not understand your expense message. Please try again with details like '$50 for nails from Home Depot'.</Message></Response>`);
                    }
                } catch (jsonError) {
                    console.error("[ERROR] GPT-3.5 returned invalid JSON:", responseText);
                    return res.send(`<Response><Message>⚠️ Could not parse your message as an expense. Please try again.</Message></Response>`);
                }
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
        }
    } catch (error) {
        console.error("[ERROR] Processing webhook request failed:", error);
        return res.send(`<Response><Message>⚠️ Internal Server Error. Please try again.</Message></Response>`);
    }
    // Default response for unhandled messages
reply = "⚠️ Sorry, I didn't understand that. Please provide an expense, revenue, or job command.";
return res.send(`<Response><Message>${reply}</Message></Response>`);
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