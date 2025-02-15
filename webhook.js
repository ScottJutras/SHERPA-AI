require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const bodyParser = require('body-parser');
const axios = require('axios');
const areaCodeMap = require('./utils/areaCodes'); // Adjust the path if necessary
const { parseExpenseMessage, parseRevenueMessage } = require('./utils/expenseParser'); 
const {
    getUserProfile,
    saveUserProfile,
    logRevenueEntry,
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
const { transcribeAudio } = require('./utils/transcriptionService');
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

// Helper functions for onboarding state persistence in Firestore
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

// ─── UTILITY FUNCTIONS ─────────────────────────────────────────────
function detectCountryAndRegion(phoneNumber) {
    if (!phoneNumber.startsWith("+")) {
        phoneNumber = `+${phoneNumber}`;  // Normalize phone number
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

// ─── EXPRESS APP SETUP ───────────────────────────────────────────────
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ─── ONBOARDING STEPS & STATE ─────────────────────────────────────────
const onboardingSteps = [
    "Can I get your name?",                                      // Step 0
    "Are you in Canada or USA? (Canada/USA)",                    // Step 1
    "Which province or state are you in?",                       // Step 2
    "What type of business do you have? (Sole Proprietorship, Corporation, Charity, Non-Profit, Other)",  // Step 3
    "What industry do you work in? (Construction, Real Estate, Retail, Freelancer, Other)",                 // Step 4
    "Do you want to track personal expenses too? (Yes/No)",      // Step 5
    "Do you want to track mileage? (Yes/No)",                     // Step 6
    "Do you want to track home office deductions? (Yes/No)",      // Step 7
    "What is your primary financial goal? (Save to pay off debts, Save to invest, Spend to lower tax bracket, Spend to invest)", // Step 8
    "Would you like to add your yearly, monthly, weekly, or bi-weekly bills to track? (Yes/No)",                // Step 9
    "Can I get your email address?"                              // Step 10
];
const userOnboardingState = {};

// Mapping of onboarding step indexes to approved template names
const onboardingTemplates = {
    1: "HX4cf7529ecaf5a488fdfa96b931025023", // onboarding_country
    3: "HX066a88aad4089ba4336a21116e923557", // onboarding_business_type
    4: "HX1d4c5b90e5f5d7417283f3ee522436f4", // onboarding_industry
    5: "HX5c80469d7ba195623a4a3654a27c19d7", // onboarding_personal_expenses
    6: "HXd1fcd47418eaeac8a94c57b930f86674", // onboarding_mileage_tracking
    7: "HX3e231458c97ba2ca1c5588b54e87c081", // onboarding_home_office
    8: "HX20b1be5490ea39f3730fb9e70d5275df", // copy_onboarding_financial_goal
    9: "HX99fd5cad1d49ab68e9afc6a70fe4d24a"  // copy_onboarding_bill_tracking
};
// ─── EXISTING QUICK REPLY FUNCTION (Legacy) ─────────────────────────
// (Retained here for reference; new messages will use sendTemplateMessage)
// const sendQuickReply = async (from, text, buttons) => { ... };

// ─── NEW FUNCTION: Send Approved Template Message ─────────────────────
const sendTemplateMessage = async (to, contentSid, contentVariables = {}) => {
    try {
        if (!contentSid) {
            console.error("[ERROR] Missing ContentSid for Twilio template message.");
            return false;
        }
        if (!to || !process.env.TWILIO_WHATSAPP_NUMBER) {
            console.error("[ERROR] Missing required phone numbers for Twilio message.");
            return false;
        }

        // Twilio requires ContentVariables to be a JSON string
        const formattedVariables = JSON.stringify(contentVariables);

        console.log("[DEBUG] Sending Twilio template message with:", {
            To: to,
            ContentSid: contentSid,
            ContentVariables: formattedVariables
        });

        const response = await axios.post(
            `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
            new URLSearchParams({
                From: process.env.TWILIO_WHATSAPP_NUMBER,
                To: to,
                MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
                Body: "Template Message", // Fallback body (required)
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

        console.log(`[✅] Twilio template message sent successfully to ${to} with ContentSid "${contentSid}"`);
        return true;
    } catch (error) {
        console.error("[ERROR] Twilio template message failed:", error.response?.data || error.message);
        return false;
    }
};


// ─── WEBHOOK HANDLER ───────────────────────────────────────────────
app.post('/webhook', async (req, res) => { 
    console.log(`[DEBUG] Incoming Webhook Request from ${req.body.From}:`, JSON.stringify(req.body));

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


  // ─── ONBOARDING FLOW WITH TEMPLATE INTEGRATION ─────────────────────────
if (!userProfile) {
    // Retrieve onboarding state from Firestore
    let state = await getOnboardingState(from);
    if (!state) {
      state = { step: 0, responses: {}, detectedLocation: detectCountryAndRegion(from) };
      await setOnboardingState(from, state);
      console.log(`[DEBUG] Initialized state for ${from}:`, state);
    }
  
    // Record the user's answer for the current question (if any)
    // (We assume every incoming message is an answer to the question at index state.step)
    if (state.step < onboardingSteps.length) {
      state.responses[`step_${state.step}`] = body;
      console.log(`[DEBUG] Recorded response for step ${state.step}:`, body);
      // Advance state to the next question
      state.step++;
      await setOnboardingState(from, state);
    
    }
  
    // Check if there are more questions to ask
    if (state.step < onboardingSteps.length) {
      const nextQuestion = onboardingSteps[state.step];
      
      // If a template is mapped for this step, send the interactive template.
      if (onboardingTemplates.hasOwnProperty(state.step)) {
        // Since your templates are static, pass an empty object for ContentVariables.
        const sent = await sendTemplateMessage(from, onboardingTemplates[state.step], {});
        if (!sent) {
          console.error("Falling back to plain text question because template message sending failed");
          return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
        }
        console.log(`[DEBUG] Sent interactive template for step ${state.step} to ${from}`);
        // Return an empty response so only the interactive template appears
        return res.send(`<Response></Response>`);
      } else {
        // If no interactive template is mapped for this step, send the question as plain text.
        console.log(`[DEBUG] Sending plain text for step ${state.step} to ${from}`);
        return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
      }
    } else {
      // Final step: process final answer and complete onboarding
      const email = state.responses.step_10;
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.send(`<Response><Message>⚠️ The email address you provided doesn't seem valid. Please enter a valid email address.</Message></Response>`);
      }
      try {
        userProfile = {
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
        await saveUserProfile(userProfile);
        await deleteOnboardingState(from);
        console.log(`[DEBUG] Onboarding complete for ${from}:`, userProfile);
        return res.send(`<Response><Message>✅ Onboarding complete, ${userProfile.name}! You can now start logging expenses.</Message></Response>`);
      } catch (error) {
        console.error("[ERROR] Failed to save user profile:", error);
        return res.send(`<Response><Message>⚠️ Sorry, something went wrong while saving your profile. Please try again later.</Message></Response>`);
      }
    }
  }  
  // ─── WEBHOOK HANDLER ───────────────────────────────────────────────
app.post('/webhook', async (req, res) => { 
    console.log(`[DEBUG] Incoming Webhook Request from ${req.body.From}:`, JSON.stringify(req.body));

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

    try {
        // ─── ONBOARDING FLOW WITH TEMPLATE INTEGRATION ─────────────────────────
        if (!userProfile) {
            let state = await getOnboardingState(from);
            if (!state) {
                state = { step: 0, responses: {}, detectedLocation: detectCountryAndRegion(from) };
                await setOnboardingState(from, state);
                console.log(`[DEBUG] Initialized state for ${from}:`, state);
            }
        
            // Record the user's answer for the current question (if any)
            if (state.step < onboardingSteps.length) {
                state.responses[`step_${state.step}`] = body;
                console.log(`[DEBUG] Recorded response for step ${state.step}:`, body);
                state.step++;
                await setOnboardingState(from, state);
            }
        
            if (state.step < onboardingSteps.length) {
                const nextQuestion = onboardingSteps[state.step];
                if (onboardingTemplates.hasOwnProperty(state.step)) {
                    const sent = await sendTemplateMessage(from, onboardingTemplates[state.step], {});
                    if (!sent) {
                        console.error("Falling back to plain text question because template message sending failed");
                        return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
                    }
                    return res.send(`<Response></Response>`);
                } else {
                    return res.send(`<Response><Message>${nextQuestion}</Message></Response>`);
                }
            } else {
                const email = state.responses.step_10;
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(email)) {
                    return res.send(`<Response><Message>⚠️ The email address you provided doesn't seem valid. Please enter a valid email address.</Message></Response>`);
                }
                try {
                    userProfile = {
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
                    await saveUserProfile(userProfile);
                    await deleteOnboardingState(from);
                    console.log(`[DEBUG] Onboarding complete for ${from}:`, userProfile);
                    return res.send(`<Response><Message>✅ Onboarding complete, ${userProfile.name}! You can now start logging expenses.</Message></Response>`);
                } catch (error) {
                    console.error("[ERROR] Failed to save user profile:", error);
                    return res.send(`<Response><Message>⚠️ Sorry, something went wrong while saving your profile. Please try again later.</Message></Response>`);
                }
            }
        }  

        // ─── Log Revenue ─────────────────────────────
        console.log("[DEBUG] Checking for revenue pattern in message:", body);
        const revenuePattern = /received\s*(\$?\d+(?:\.\d{2})?)\s*from\s*(.+)/i;
        const match = body.match(revenuePattern);

        if (match) {
            const amount = match[1].startsWith('$') ? match[1] : `$${match[1]}`;
            const source = match[2].trim();
            const date = new Date().toISOString().split('T')[0]; // Current date
            const category = "General Revenue";
            const paymentMethod = "Unknown";
            const notes = "Logged via WhatsApp";

            console.log("[DEBUG] Calling logRevenueEntry with:", {
                userEmail: userProfile.email,
                date, amount, source, category, paymentMethod, notes
            });

            try {
                const success = await logRevenueEntry(from, date, amount, source, category, paymentMethod, notes);
                if (success) {
                    return res.send(`<Response><Message>✅ Revenue of ${amount} from ${source} logged successfully.</Message></Response>`);
                } else {
                    return res.send(`<Response><Message>⚠️ Failed to log revenue.</Message></Response>`);
                }
            } catch (error) {
                console.error('Error logging revenue:', error);
                return res.send(`<Response><Message>⚠️ Internal server error while logging revenue.</Message></Response>`);
            }
        }

        // ─── Continue Processing Other Message Types ─────────────────────────────
        console.log("[DEBUG] Message is not revenue. Continuing to process as regular input...");
        let reply = "⚠️ I couldn't understand your request. Please try again with more details.";
        return res.send(`<Response><Message>${reply}</Message></Response>`);
    
    } catch (error) {
        console.error("[ERROR] Processing webhook request failed:", error);
        return res.send(`<Response><Message>⚠️ Internal Server Error. Please try again.</Message></Response>`);
    }
});

    // ─── NON-ONBOARDING FLOW FOR RETURNING USERS ─────────────
    let reply;
    try {
        // Handle user confirmation with quick replies for pending expense/revenue/bill entries
        if (userOnboardingState[from]?.pendingExpense || userOnboardingState[from]?.pendingRevenue || userOnboardingState[from]?.pendingBill) {
            const pendingData = userOnboardingState[from].pendingExpense || userOnboardingState[from].pendingRevenue || userOnboardingState[from].pendingBill;
            const type = userOnboardingState[from].pendingExpense
                ? 'expense'
                : userOnboardingState[from].pendingRevenue
                ? 'revenue'
                : 'bill';
            const activeJob = await getActiveJob(from) || "Uncategorized";

            if (body.toLowerCase() === 'yes') {
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
                    reply = `✅ ${type.charAt(0).toUpperCase() + type.slice(1)} confirmed and logged: ${pendingData.item || pendingData.source || pendingData.billName} for ${pendingData.amount} on ${pendingData.date}`;
                }
            } else if (body.toLowerCase() === 'no' || body.toLowerCase() === 'edit') {
                reply = "✏️ Okay, please resend the correct details.";
                delete userOnboardingState[from].pendingExpense;
                delete userOnboardingState[from].pendingRevenue;
                delete userOnboardingState[from].pendingBill;
            } else if (body.toLowerCase() === 'cancel') {
                reply = "🚫 Entry canceled.";
                delete userOnboardingState[from].pendingExpense;
                delete userOnboardingState[from].pendingRevenue;
                delete userOnboardingState[from].pendingBill;
            } else {
                // Instead of sending a plain text quick reply, use the approved template.
                // For example, for pending expense entries we use the "onboarding_personal_expenses" template.
                await sendTemplateMessage(
                    from,
                    "onboarding_personal_expenses", // Update with your desired template name
                    [`Please confirm: ${pendingData.amount} for ${pendingData.item || pendingData.source || pendingData.billName} on ${pendingData.date}`],
                    ["Yes", "Edit", "Cancel"]
                );
                return res.send(`<Response><Message>✅ Quick Reply Sent. Please respond.</Message></Response>`);
            }
            return res.send(`<Response><Message>${reply}</Message></Response>`);
        }

        // ─── Media Handling: Voice Notes & Receipt Images ─────────────
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
        if (mediaUrl && mediaType?.includes("image")) {
            const ocrText = await extractTextFromImage(mediaUrl);
            if (ocrText) {
                combinedText += ocrText;
                console.log(`[DEBUG] OCR Text: "${ocrText}"`);
            }
        }

        // ─── Expense Parsing from Combined Text ─────────────
        if (combinedText) {
            const expenseData = parseExpenseMessage(combinedText);
            if (expenseData) {
                // Store pending expense BEFORE sending response
                userOnboardingState[from] = { pendingExpense: expenseData };
                await sendTemplateMessage(
                    from,
                    "onboarding_personal_expenses", // Use the appropriate approved template for expense confirmation
                    [`Did you mean: ${expenseData.amount} for ${expenseData.item} from ${expenseData.store} on ${expenseData.date}?`],
                    ["Yes", "Edit", "Cancel"]
                );
                return res.send(`<Response><Message>✅ Quick Reply Sent. Please respond.</Message></Response>`);
            } else {
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

    // ─── Job Start, Income Goal, Revenue, & Text-Based Expense Handling ─────────────
    if (body.toLowerCase().startsWith("start job ")) {
        reply = await handleStartJob(from, body);
    } else if (body.includes("how much do i need to make") || body.includes("income goal")) {
        const incomeGoal = await calculateIncomeGoal(from);
        if (incomeGoal) {
            reply = `📈 To cover your expenses next month, you need to make **$${incomeGoal}**. This includes your recurring bills, average variable expenses, and a 10% savings target.`;
            res.set('Content-Type', 'text/xml');
            return res.send(`<Response><Message>${reply}</Message></Response>`);
        } else {
            reply = "⚠️ I couldn't calculate your income goal right now. Please ensure your expenses and bills are logged correctly.";
            res.set('Content-Type', 'text/xml');
            return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
    } else if (body.toLowerCase().startsWith("received") || body.toLowerCase().startsWith("earned") || body.toLowerCase().startsWith("income") || body.toLowerCase().startsWith("revenue")) {
        console.log("[DEBUG] Detected a revenue message:", body);
        const activeJob = await getActiveJob(from) || "Uncategorized";
        let revenueData = parseRevenueMessage(body);
        if (!revenueData) {
            console.log("[DEBUG] Parsed Revenue Data:", { date, amount, source });
            console.log("[DEBUG] Regex parsing failed for revenue, using GPT-3.5 for fallback...");

            const gptResponse = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: "You are an assistant that extracts structured revenue data from messages." },
                    { role: "user", content: `Extract the date, amount, and source from this revenue message: \"${body}\". Return in JSON format like this: {"date": "YYYY-MM-DD", "amount": "$AMOUNT", "source": "SOURCE"}.` }
                ]
            });
            console.log("[DEBUG] GPT Response for Revenue:", gptResponse.choices[0].message.content);

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
            userOnboardingState[from] = { pendingRevenue: revenueData };
        
            console.log("[DEBUG] Sending Twilio pay_confirmation template...");
            
            await sendTemplateMessage(
                from,
                "HX9382ee3fb669bc5cf11423d137a25308", // ✅ Correct Twilio Template SID
                { 
                    amount: revenueData.amount, 
                    source: revenueData.source, 
                    date: revenueData.date 
                }
            );
        
            return res.send(`<Response><Message>✅ Quick Reply Sent. Please respond.</Message></Response>`);
        } else {
            reply = "⚠️ Could not understand your revenue message. Please provide more details.";
        }
    } else if (body) {
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
                        content: `Extract the date, item, amount, and store from this message: \"${body}\". Return in JSON format like this: {"date": "YYYY-MM-DD", "item": "ITEM", "amount": "$AMOUNT", "store": "STORE"}.`
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
            await sendTemplateMessage(
                from,
                "onboarding_personal_expenses", // Use the appropriate approved template for expense confirmation
                [`Did you mean: ${expenseData.amount} for ${expenseData.item} from ${expenseData.store} on ${expenseData.date}?`],
                ["Yes", "Edit", "Cancel"]
            );
            return res.send(`<Response><Message>✅ Quick Reply Sent. Please respond.</Message></Response>`);
        } else {
            reply = "⚠️ Could not understand your request. Please provide a valid expense message.";
        }
    }
    
    if (!reply) {
        reply = "⚠️ I couldn't understand your request. Please try again with more details.";
    }    
    res.set('Content-Type', 'text/xml');
    console.log(`[DEBUG] Reply sent to ${from}: "${reply}"`);
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
    const jobMatch = body.match(/start job (.+)/i);
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
