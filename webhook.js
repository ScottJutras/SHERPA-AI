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
    getActiveJob,
    createSpreadsheetForUser,
    calculateIncomeGoal  // Ensure this is exported from googleSheets
} = require("./utils/googleSheets");

const { extractTextFromImage } = require('./utils/visionService');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
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
function normalizePhoneNumber(phone) {
  return phone.replace(/^whatsapp:/i, '').trim();
}

function detectCountryAndRegion(phoneNumber) {
  // Optionally, you can normalize the phone here if needed,
  // or assume the phone is already normalized.
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
const userOnboardingState = {}; // Retained for legacy use if needed

// Mapping of onboarding step indexes to approved template SIDs
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
const confirmationTemplates = {
    revenue: "HX9382ee3fb669bc5cf11423d137a25308",  // Revenue Confirmation
    expense: "HX00a562789f55a45fcbd13dc67f8249b6",  // Expense Confirmation
    bill:    "HXe7a1b06a28554ec2bced55944e05c465",  // Bill Confirmation
    startJob:"HXa4f19d568b70b3493e64933ce5e6a040"   // Start Job
  };
  

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

// ─── WEBHOOK HANDLER  ─────────────────────────────
app.post('/webhook', async (req, res) => {
    // Normalize the incoming phone number
    const rawPhone = req.body.From;
    const phone = normalizePhoneNumber(rawPhone);
    
    console.log(`[DEBUG] Incoming Webhook Request from ${phone}:`, JSON.stringify(req.body));
   

    const body = req.body.Body?.trim();
    const mediaUrl = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0;

    if (!phone) {
        return res.status(400).send("Bad Request: Missing 'From'.");
    }

    let userProfile;
    try {
        userProfile = await getUserProfile(phone);
    } catch (error) {
        console.error("[ERROR] Failed to fetch user profile:", error);
        return res.send(`<Response><Message>⚠️ Sorry, something went wrong. Please try again.</Message></Response>`);
    }
    try {
        // ─── ONBOARDING FLOW ─────────────────────────
if (!userProfile) {
    let state = await getOnboardingState(from);
    // If no state exists, initialize and send the first question without recording the incoming message.
    if (!state) {
        state = { step: 0, responses: {}, detectedLocation: detectCountryAndRegion(from) };
        await setOnboardingState(from, state);
        console.log(`[DEBUG] Initialized state for ${from}:`, state);
        const firstQuestion = onboardingSteps[0]; // "Can I get your name?"
        console.log(`[DEBUG] Sending first question to ${from}:`, firstQuestion);
        return res.send(`<Response><Message>${firstQuestion}</Message></Response>`);
    }
    // Otherwise, if state exists, record the user's answer for the current question
    if (state.step < onboardingSteps.length) {
        state.responses[`step_${state.step}`] = body;
        console.log(`[DEBUG] Recorded response for step ${state.step}:`, body);
        state.step++;
        await setOnboardingState(from, state);
    }
    // Send the next question if available
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
                // Final step: complete onboarding
const email = state.responses.step_10;
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!emailRegex.test(email)) {
  return res.send(`<Response><Message>⚠️ The email address you provided doesn't seem valid. Please enter a valid email address.</Message></Response>`);
}

try {
    const userProfileData = {
        user_id: phone, // use the normalized phone number here
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

// Create or retrieve the spreadsheet for the user.
const spreadsheetId = await createSpreadsheetForUser(phone, userProfileData.email);

// Delete onboarding state, etc.
await deleteOnboardingState(from);

console.log(`[DEBUG] Onboarding complete for ${phone}:`, userProfileData);
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
  
    // ─── Non‐Onboarding Flow (Returning Users) ─────────────────────────

// 0. Start Job Command
if (/^(start job|job start)\s+(.+)/i.test(body)) {
    let jobName;
    const jobMatch = body.match(/^(start job|job start)\s+(.+)/i);
    if (jobMatch && jobMatch[2]) {
      jobName = jobMatch[2].trim();
    }
    // If regex didn't capture a valid job name, fall back to GPT‑3.5
    if (!jobName) {
      try {
        const gptResponse = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content: "Extract the job name from the following message. Return only the job name as plain text."
            },
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
      return res.send(`<Response><Message>✅ Job "${jobName}" is now active. All expenses will be assigned to this job.</Message></Response>`);
    } else {
      return res.send(`<Response><Message>⚠️ Could not determine the job name. Please specify the job name.</Message></Response>`);
    }
  }
  
  // 0.5 Add Bill Command (if you want a dedicated branch for bills)
  // (Assuming that a bill message contains the word "bill" and some details)
  else if (body.toLowerCase().includes("bill")) {
    // Try to extract basic bill details using a simple regex or split logic
    // For example, we expect a message like "bill [name] $[amount] due [date]"
    let billData = null;
    const billRegex = /bill\s+([\w\s]+)\s+\$([\d,]+(?:\.\d{1,2})?)\s+due\s+([\w\d-]+)/i;
    const billMatch = body.match(billRegex);
    if (billMatch) {
      billData = {
        billName: billMatch[1].trim(),
        amount: `$${parseFloat(billMatch[2].replace(/,/g, '')).toFixed(2)}`,
        dueDate: billMatch[3].trim()
      };
    }
    // If the regex fails to extract all fields, fall back to GPT‑3.5
    if (!billData || !billData.billName || !billData.amount || !billData.dueDate) {
      try {
        const gptResponse = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content: "Extract bill details from the following message. Return a JSON object with keys: billName, amount, dueDate."
            },
            { role: "user", content: `Message: "${body}"` }
          ],
          max_tokens: 60,
          temperature: 0.3
        });
        billData = JSON.parse(gptResponse.choices[0].message.content);
      } catch (error) {
        console.error("[ERROR] GPT fallback for bill parsing failed:", error);
      }
    }
    if (billData && billData.billName && billData.amount && billData.dueDate) {
      // Process the bill (e.g., add it to the spreadsheet)
      const activeJob = (await getActiveJob(from)) || "Uncategorized";
      await appendToUserSpreadsheet(from, [
        billData.dueDate,
        billData.billName,
        billData.amount,
        'Recurring Bill',
        activeJob,
        'bill',
        'recurring'
      ]);
      return res.send(`<Response><Message>✅ Bill "${billData.billName}" for ${billData.amount} due on ${billData.dueDate} added.</Message></Response>`);
    } else {
      return res.send(`<Response><Message>⚠️ Could not parse bill details. Please provide the details in the format: "bill [name] $[amount] due [date]".</Message></Response>`);
    }
  }
    
    // 1. Pending Confirmations (Expense, Revenue, or Bill)
    if (
      userOnboardingState[from]?.pendingExpense ||
      userOnboardingState[from]?.pendingRevenue ||
      userOnboardingState[from]?.pendingBill
    ) {
      const pendingData =
        userOnboardingState[from].pendingExpense ||
        userOnboardingState[from].pendingRevenue ||
        userOnboardingState[from].pendingBill;
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
              : `⚠️ Failed to log revenue.`;
          } catch (error) {
            console.error("[ERROR] Error logging revenue:", error);
            reply = "⚠️ Internal server error while logging revenue.";
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
        if (type === 'expense' || type === 'bill') {
          await sendTemplateMessage(
            from,
            confirmationTemplates.expense,
            { "1": `Please confirm: ${pendingData.amount} for ${pendingData.item || pendingData.source || pendingData.billName} on ${pendingData.date}` }
          );
        } else if (type === 'revenue') {
          await sendTemplateMessage(
            from,
            confirmationTemplates.revenue,
            { "1": `Please confirm: Revenue of ${pendingData.amount} from ${pendingData.source} on ${pendingData.date}` }
          );
        }
        return res.send(`<Response><Message>✅ Quick Reply Sent. Please respond.</Message></Response>`);
      }
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
  
    // 2. Revenue Logging Branch (for new revenue messages)
else if (
    body.toLowerCase().startsWith("received") ||
    body.toLowerCase().startsWith("earned") ||
    body.toLowerCase().startsWith("income") ||
    body.toLowerCase().startsWith("revenue")
  ) {
    console.log("[DEBUG] Detected a revenue message:", body);
    const activeJob = (await getActiveJob(from)) || "Uncategorized";
    let revenueData = parseRevenueMessage(body);
    // If regex fails to extract required fields, fall back to GPT‑3.5
    if (!revenueData || !revenueData.amount || !revenueData.source) {
      console.log("[DEBUG] Regex parsing failed for revenue, using GPT-3.5 for fallback...");
      try {
        const gptResponse = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content: "Extract structured revenue data from the following message. Return JSON with keys: date, amount, source."
            },
            {
              role: "user",
              content: `Message: "${body}"`
            }
          ],
          max_tokens: 60,
          temperature: 0.3
        });
        revenueData = JSON.parse(gptResponse.choices[0].message.content);
        // Trim whitespace and set a default date if missing
        revenueData.amount = revenueData.amount ? revenueData.amount.trim() : "";
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
    // Store revenue data for pending confirmation
    userOnboardingState[from] = { pendingRevenue: revenueData };
    // Use the revenue confirmation quick reply template
    await sendTemplateMessage(
      from,
      confirmationTemplates.revenue, // e.g., "HX9382ee3fb669bc5cf11423d137a25308"
      { "1": `Please confirm: Revenue of ${revenueData.amount} from ${revenueData.source} on ${revenueData.date}` }
    );
    return res.send(`<Response><Message>✅ Quick Reply Sent. Please respond.</Message></Response>`);
    }
// ─── Media Handling for Expense Logging (if media is attached) ─────────────────────────
else if (mediaUrl) {
    console.log("[DEBUG] Checking media in message...");
    let combinedText = "";
    
    // Audio: Transcribe voice recordings
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
        console.error("[ERROR] Failed to process audio:", error);
      }
    }
    
    // Image: First try OCR; if that fails, fall back to Document AI
    if (mediaType && mediaType.includes("image")) {
      let ocrText = "";
      try {
        ocrText = await extractTextFromImage(mediaUrl);
        console.log(`[DEBUG] OCR Text: "${ocrText}"`);
      } catch (err) {
        console.error("[ERROR] OCR extraction error:", err);
      }
      // If OCR didn't return text, try Document AI fallback
      if (!ocrText || ocrText.trim() === "") {
        console.log("[DEBUG] OCR extraction returned empty, falling back to Document AI...");
        try {
          // Make sure you have implemented extractTextFromDocumentAI appropriately.
          const documentAIText = await extractTextFromDocumentAI(mediaUrl);
          ocrText = documentAIText;
          console.log(`[DEBUG] Document AI extracted text: "${documentAIText}"`);
        } catch (error) {
          console.error("[ERROR] Document AI extraction failed:", error);
        }
      }
      combinedText += ocrText + " ";
    }
    
    // If we have any combined text from media, try parsing expense data
    if (combinedText) {
      let expenseData = parseExpenseMessage(combinedText);
      // If regex parsing fails or returns incomplete data, fall back to GPT‑3.5
      if (!expenseData || !expenseData.item || !expenseData.amount || !expenseData.store) {
        console.log("[DEBUG] Regex parsing failed for expense from media, using GPT-3.5 for fallback...");
        try {
          const gptResponse = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
              {
                role: "system",
                content: "Extract structured expense data from the following text. Return JSON with keys: date, item, amount, store."
              },
              {
                role: "user",
                content: `Text: "${combinedText.trim()}"`
              }
            ],
            max_tokens: 60,
            temperature: 0.3
          });
          expenseData = JSON.parse(gptResponse.choices[0].message.content);
          if (!expenseData.date) {
            expenseData.date = new Date().toISOString().split("T")[0];
          }
          console.log("[DEBUG] GPT-3.5 Fallback Expense Result:", expenseData);
        } catch (error) {
          console.error("[ERROR] GPT-3.5 expense parsing failed:", error);
        }
      }
      if (expenseData && expenseData.item && expenseData.amount && expenseData.store) {
        userOnboardingState[from] = { pendingExpense: expenseData };
        await sendTemplateMessage(
          from,
          confirmationTemplates.expense, // e.g., "HX00a562789f55a45fcbd13dc67f8249b6"
          { "1": `Please confirm: ${expenseData.amount} for ${expenseData.item} from ${expenseData.store} on ${expenseData.date}?` }
        );
        return res.send(`<Response><Message>✅ Quick Reply Sent. Please respond.</Message></Response>`);
      } else {
        return res.send(`<Response><Message>⚠️ I couldn't parse the expense details from the media. Please try again.</Message></Response>`);
      }
    } else {
      return res.send(`<Response><Message>⚠️ No media detected or unable to extract information. Please resend.</Message></Response>`);
    }
  }
    // 4. Expense Logging for Text Messages
else if (body) {
    const activeJob = (await getActiveJob(from)) || "Uncategorized";
    let expenseData = parseExpenseMessage(body);
    // If regex fails or any required field is missing, fall back to GPT‑3.5
    if (!expenseData || !expenseData.item || !expenseData.amount || !expenseData.store) {
      console.log("[DEBUG] Regex parsing failed for expense, using GPT-3.5 for fallback...");
      try {
        const gptResponse = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content: "Extract structured expense data from the following message. Return JSON with keys: date, item, amount, store."
            },
            {
              role: "user",
              content: `Message: "${body}"`
            }
          ],
          max_tokens: 60,
          temperature: 0.3
        });
        expenseData = JSON.parse(gptResponse.choices[0].message.content);
        if (!expenseData.date) {
          expenseData.date = new Date().toISOString().split("T")[0];
        }
        console.log("[DEBUG] GPT-3.5 Fallback Expense Result:", expenseData);
      } catch (error) {
        console.error("[ERROR] GPT-3.5 expense parsing failed:", error);
      }
    }
    if (expenseData && expenseData.item && expenseData.amount && expenseData.store) {
      userOnboardingState[from] = { pendingExpense: expenseData };
      await sendTemplateMessage(
        from,
        confirmationTemplates.expense, // e.g., "HX00a562789f55a45fcbd13dc67f8249b6"
        { "1": `Please confirm: ${expenseData.amount} for ${expenseData.item} from ${expenseData.store} on ${expenseData.date}?` }
      );
      return res.send(`<Response><Message>✅ Quick Reply Sent. Please respond.</Message></Response>`);
    } else {
      reply = "⚠️ Could not understand your expense message. Please provide a valid expense message.";
    }
  }
    res.set('Content-Type', 'text/xml');
    console.log(`[DEBUG] Reply sent to ${from}: "${reply}"`);
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
