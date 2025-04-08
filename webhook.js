require('dotenv').config();

// Core Node.js utilities
const { URLSearchParams } = require('url');
const fs = require('fs');
const path = require('path');
const { db, storage } = require('./firebase');

// Third-party libraries
const admin = require("firebase-admin");
const express = require('express');
const OpenAI = require('openai');
const axios = require('axios');
const { google } = require('googleapis');
const PDFKit = require('pdfkit');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const Papa = require('papaparse');
const XLSX = require('xlsx');

// Local utilities
const { handleInputWithAI } = require('./utils/aiErrorHandler');
const areaCodeMap = require('./utils/areaCodes');
const { parseExpenseMessage, parseRevenueMessage } = require('./utils/expenseParser');
const { processDocumentAI } = require('./documentAI');
const { transcribeAudio } = require('./utils/transcriptionService');
const { detectErrors, correctErrorsWithAI } = require('./utils/errorDetector');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('./utils/stateManager');
const { sendTemplateMessage } = require('./utils/twilioHelper');
const { updateUserTokenUsage, checkTokenLimit, getSubscriptionTier } = require('./utils/tokenManager');
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
    calculateIncomeGoal,
    fetchMaterialPrices,
} = require("./utils/googleSheets");
const { detectCountryAndRegion } = require('./utils/location');
const { extractTextFromImage } = require('./utils/visionService');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { sendSpreadsheetEmail, sendEmail } = require('./utils/sendGridService');
const { generateQuotePDF } = require('./utils/pdfService');
const { parseQuoteMessage, buildQuoteDetails } = require('./utils/quoteUtils');
const { getAuthorizedClient } = require("./utils/googleSheets");
const { getTaxRate } = require('./utils/taxRate.js');

// Google credentials
const googleCredentials = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
console.log('[DEBUG] Service account email from GOOGLE_CREDENTIALS_BASE64:', googleCredentials.client_email);

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
async function updateBillInSheets(userId, billData) {
    try {
        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = (await getUserProfile(userId)).spreadsheetId;
        const range = 'Sheet1!A:I';
        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
        const rows = response.data.values || [];
        const header = rows[0];
        const dataRows = rows.slice(1);

        // Find the bill by name and type 'bill'
        const billRowIndex = dataRows.findIndex(row => 
            row[1]?.toLowerCase() === billData.billName.toLowerCase() && row[5] === 'bill'
        );
        
        if (billRowIndex === -1) {
            console.log(`[⚠️] Bill "${billData.billName}" not found in Sheets.`);
            return false;
        }

        const rowIndex = billRowIndex + 2; // +1 for header, +1 for 1-based index
        const existingRow = dataRows[billRowIndex];
        const updatedRow = [
            billData.date || existingRow[0],           // Date
            billData.billName,                         // Name
            billData.amount || existingRow[2],         // Amount
            billData.recurrence || existingRow[3],     // Recurrence (stored in store/source column)
            existingRow[4],                            // Job
            'bill',                                    // Type
            existingRow[6],                            // Category
            existingRow[7] || '',                      // Media URL
            existingRow[8] || 'Unknown'                // Logged By
        ];

        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `Sheet1!A${rowIndex}:I${rowIndex}`,
            valueInputOption: 'RAW',
            resource: { values: [updatedRow] }
        });
        console.log(`[✅] Bill "${billData.billName}" updated in Sheets at row ${rowIndex}.`);
        return true;
    } catch (error) {
        console.error(`[ERROR] Failed to update bill "${billData.billName}" in Sheets:`, error);
        return false;
    }
}

async function deleteBillInSheets(userId, billName) {
    try {
        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = (await getUserProfile(userId)).spreadsheetId;
        const range = 'Sheet1!A:I';
        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
        const rows = response.data.values || [];
        const dataRows = rows.slice(1);

        // Find the bill by name and type 'bill'
        const billRowIndex = dataRows.findIndex(row => 
            row[1]?.toLowerCase() === billName.toLowerCase() && row[5] === 'bill'
        );
        
        if (billRowIndex === -1) {
            console.log(`[⚠️] Bill "${billName}" not found in Sheets.`);
            return false;
        }

        const rowIndex = billRowIndex + 2; // +1 for header, +1 for 1-based index
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `Sheet1!A${rowIndex}:I${rowIndex}`,
            valueInputOption: 'RAW',
            resource: { values: [[]] } // Clear the row
        });
        console.log(`[✅] Bill "${billName}" deleted from Sheets at row ${rowIndex}.`);
        return true;
    } catch (error) {
        console.error(`[ERROR] Failed to delete bill "${billName}" in Sheets:`, error);
        return false;
    }
}

// Team Management Functions
const getTeamInfo = async (phoneNumber) => {
    const userRef = db.collection('users').doc(phoneNumber);
    const doc = await userRef.get();
    return doc.exists ? { ownerId: phoneNumber, teamMembers: doc.data().teamMembers || [] } : null;
};

const getOwnerFromTeamMember = async (phoneNumber) => {
    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('teamMembers', 'array-contains', { phone: phoneNumber }).get();
    if (!snapshot.empty) {
        const ownerDoc = snapshot.docs[0];
        return { ownerId: ownerDoc.id, teamMembers: ownerDoc.data().teamMembers || [] };
    }
    return null;
};

const addTeamMember = async (ownerPhone, memberName, memberPhone) => {
    const userRef = db.collection('users').doc(ownerPhone);
    const doc = await userRef.get();
    const teamMembers = doc.data().teamMembers || [];
    if (!teamMembers.some(member => member.phone === memberPhone)) {
        teamMembers.push({ name: memberName, phone: memberPhone, role: 'member' });
        await userRef.update({ teamMembers });
        console.log(`[✅] Added ${memberName} (${memberPhone}) to ${ownerPhone}'s team`);
    }
};

const removeTeamMember = async (ownerPhone, memberPhone) => {
    const userRef = db.collection('users').doc(ownerPhone);
    const doc = await userRef.get();
    const teamMembers = doc.data().teamMembers || [];
    const updatedTeamMembers = teamMembers.filter(member => member.phone !== memberPhone);
    await userRef.update({ teamMembers: updatedTeamMembers });
    console.log(`[✅] Removed ${memberPhone} from ${ownerPhone}'s team`);
};

// Utility Functions
function normalizePhoneNumber(phone) {
    return phone
        .replace(/^whatsapp:/i, '')
        .replace(/^\+/, '')
        .trim();
}

// Express App Setup
const app = express();
app.use(express.json({ limit: '50mb' })); // For Deep Dive file uploads
app.use(express.urlencoded({ extended: true }));

const onboardingSteps = [
    "Can I get your name?",
];

const teamMemberOnboardingSteps = [
    "Can I get your name?"
];

const onboardingTemplates = {
    1: "HX4cf7529ecaf5a488fdfa96b931025023",
    4: "HX066a88aad4089ba4336a21116e923557",
    5: "HX1d4c5b90e5f5d7417283f3ee522436f4",
    6: "HX5c80469d7ba195623a4a3654a27c19d7",
    7: "HXd1fcd47418eaeac8a94c57b930f86674",
    8: "HX3e231458c97ba2ca1c5588b54e87c081",
    9: "HX20b1be5490ea39f3730fb9e70d5275df",
    10: "HX99fd5cad1d49ab68e9afc6a70fe4d24a",
    12: "HXf6e1f67ace192ccd21d6e187ea7d6c34"
};

const confirmationTemplates = {
    revenue: "HXb3086ca639cb4882fb2c68f2cd569cb4",
    expense: "HX9f6b7188f055fa25f8170f915e53cbd0",
    bill: "HX6de403c09a8ec90183fbb3fe05413252",
    startJob: "HXa4f19d568b70b3493e64933ce5e6a040",
    locationConfirmation: "HX0280df498999848aaff04cc079e16c31",
    spreadsheetLink: "HXf5964d5ffeecc5e7f4e94d7b3379e084",
    deleteConfirmation: "HXabcdef1234567890abcdef123456789", // Placeholder; replace with actual template ID
    teamMemberInvite: "HX1234567890abcdef1234567890abcdef" // Placeholder; replace with actual template ID
};
// Default tax preparation categories (aligned with Schedule C for simplicity)
const defaultExpenseCategories = {
    "Advertising": ["marketing", "ads", "promotion"],
    "Car and Truck Expenses": ["fuel", "mileage", "vehicle", "gas"],
    "Contract Labor": ["labor", "subcontractor", "worker"],
    "Cost of Goods Sold": ["materials", "supplies", "inventory"],
    "Insurance": ["insurance", "premium"],
    "Office Expenses": ["stationery", "paper", "office supplies"],
    "Rent or Lease": ["rent", "lease", "rental"],
    "Repairs and Maintenance": ["repair", "maintenance", "fix"],
    "Supplies": ["tools", "equipment", "nails", "paint"],
    "Taxes and Licenses": ["tax", "license", "permit"],
    "Travel": ["travel", "hotel", "flight"],
    "Meals": ["meal", "food", "dining"],
    "Utilities": ["electricity", "water", "internet", "phone"],
    "Other Expenses": ["misc", "miscellaneous", "general"]
};

const defaultRevenueCategories = {
    "Revenue - Services": ["service", "labor", "work"],
    "Revenue - Sales": ["sale", "product", "goods"],
    "Revenue - Other": ["misc", "other", "miscellaneous"]
};


// Function to determine category using AI
const categorizeEntry = async (type, data, userProfile) => {
    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const inputText = type === 'expense'
        ? `${data.item} from ${data.store}`
        : `${data.description} from ${data.source || data.client}`;
    const industry = userProfile.industry || "Other";
    const prompt = `
        Categorize this ${type} for tax preparation based on a CFO's perspective:
        - Input: "${inputText}"
        - Industry: "${industry}"
        - Available ${type} categories: ${JSON.stringify(type === 'expense' ? defaultExpenseCategories : defaultRevenueCategories, null, 2)}
        Return JSON: { category: "string" }
    `;

    const gptResponse = await openaiClient.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
            { role: "system", content: prompt },
            { role: "user", content: inputText }
        ],
        max_tokens: 50,
        temperature: 0.3
    });

    const result = JSON.parse(gptResponse.choices[0].message.content);
    return result.category || (type === 'expense' ? "Other Expenses" : "Revenue - Other");
};

// Deep Dive File Parsing
const parseFinancialFile = (fileBuffer, fileType) => {
    let data = [];
    if (fileType === 'text/csv') {
        const csvText = fileBuffer.toString('utf-8');
        const result = Papa.parse(csvText, { header: true, skipEmptyLines: true });
        data = result.data;
    } else if (fileType === 'application/vnd.ms-excel' || fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    }
    return data.map(row => ({
        date: row.Date || row.date || new Date().toISOString().split('T')[0],
        amount: parseFloat(row.Amount || row.amount || 0).toFixed(2),
        description: row.Description || row.description || row.Item || row.item || "Unknown",
        source: row.Source || row.source || row.Store || row.store || "Unknown",
        type: row.Type || row.type || (parseFloat(row.Amount || row.amount) >= 0 ? 'revenue' : 'expense')
    }));
};

// Deep Dive Report Generation
const generateDeepDiveReport = async (userId, data, tier) => {
    const userProfile = await getUserProfile(userId);
    const doc = new PDFKit();
    const outputPath = `/tmp/deep_dive_${userId}_${Date.now()}.pdf`;
    const chartCanvas = new ChartJSNodeCanvas({ width: 600, height: 400 });

    const expenses = data.filter(row => row.type === 'expense');
    const revenues = data.filter(row => row.type === 'revenue');
    const totalExpenses = expenses.reduce((sum, row) => sum + parseFloat(row.amount), 0);
    const totalRevenue = revenues.reduce((sum, r) => sum + parseFloat(r.amount), 0);
    const profit = totalRevenue - totalExpenses;

    doc.fontSize(16).text(`Deep Dive Financial Analysis - ${tier.name}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Generated for: ${userProfile.name || 'User'} on ${new Date().toLocaleDateString()}`);
    doc.moveDown();

    doc.text("Profit & Loss Statement");
    doc.text(`Total Revenue: $${totalRevenue.toFixed(2)}`);
    doc.text(`Total Expenses: $${totalExpenses.toFixed(2)}`);
    doc.text(`Net Profit: $${profit.toFixed(2)}`);
    doc.moveDown();

    const chartBuffer = await chartCanvas.renderToBuffer({
        type: 'bar',
        data: {
            labels: ['Revenue', 'Expenses'],
            datasets: [{ label: 'Amount ($)', data: [totalRevenue, totalExpenses], backgroundColor: ['#36A2EB', '#FF6384'] }]
        }
    });
    doc.image(chartBuffer, { width: 300 });

    if (tier.features.includes('forecast_1yr') || tier.features.includes('forecast_10yr')) {
        const forecastYears = tier.features.includes('forecast_10yr') ? 10 : 1;
        const monthlyRevenue = totalRevenue / (data.length / 30);
        const monthlyExpenses = totalExpenses / (data.length / 30);
        const forecast = [];
        for (let i = 1; i <= forecastYears * 12; i++) {
            forecast.push({
                month: new Date().setMonth(new Date().getMonth() + i),
                revenue: monthlyRevenue * (1 + 0.02 * i),
                expenses: monthlyExpenses * (1 + 0.01 * i)
            });
        }
        doc.addPage().text(`Cash Flow Forecast (${forecastYears} Year${forecastYears > 1 ? 's' : ''})`);
        forecast.slice(0, 12).forEach(f => {
            doc.text(`${new Date(f.month).toLocaleDateString()}: Revenue $${f.revenue.toFixed(2)}, Expenses $${f.expenses.toFixed(2)}, Net $${(f.revenue - f.expenses).toFixed(2)}`);
        });
    }

    if (tier.features.includes('goals')) {
        doc.addPage().text("10-Year Financial Goals");
        doc.text("- Year 1: Establish stable cash flow ($5000/month net)");
        doc.text("- Year 5: Double revenue through new product lines");
        doc.text("- Year 10: Achieve $1M in annual profit");
    }

    doc.pipe(fs.createWriteStream(outputPath));
    doc.end();

    const auth = await getAuthorizedClient();
    const drive = google.drive({ version: 'v3', auth });
    const fileMetadata = { name: `Deep_Dive_${userId}_${Date.now()}.pdf` };
    const media = { mimeType: 'application/pdf', body: fs.createReadStream(outputPath) };
    const driveResponse = await drive.files.create({
        resource: fileMetadata,
        media,
        fields: 'id, webViewLink'
    });
    await drive.permissions.create({
        fileId: driveResponse.data.id,
        requestBody: { role: 'reader', type: 'anyone' }
    });

    return driveResponse.data.webViewLink;
};

app.post('/webhook', async (req, res) => {
    const rawPhone = req.body.From;
    const from = normalizePhoneNumber(rawPhone);
    const body = req.body.Body?.trim();
    const mediaUrl = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0;

    try {
        let userProfile = await getUserProfile(from);
        const ownerInfo = await getOwnerFromTeamMember(from);
        let ownerId = userProfile?.ownerId || from;
        const isOwner = !ownerInfo || ownerId === from;
        const ownerProfile = isOwner ? userProfile : await getUserProfile(ownerId);
        const userName = userProfile?.name || 'Unknown User';
        const userProfileData = userProfile; // Alias for consistency

        await updateUserTokenUsage(ownerId, { 
            messages: 1, 
            aiCalls: (body && (body.includes('$') || body.toLowerCase().includes("received") || body.toLowerCase().startsWith("quote"))) || mediaUrl ? 1 : 0 
        });
        const subscriptionTier = await getSubscriptionTier(ownerId);
        const withinLimit = await checkTokenLimit(ownerId, subscriptionTier);
        if (withinLimit.exceeded) {
            return res.send(`<Response><Message>⚠️ Trial limit reached! Reply 'Upgrade' to continue.</Message></Response>`);
        }

        // Auto-detect Country and Province/State for new users
        if (!userProfile && !ownerInfo) {
            const countryCode = from.slice(0, 2); // e.g., "+1"
            const areaCode = from.slice(2, 5);    // e.g., "416"
            const location = countryCode === '+1' && areaCodeMap[areaCode] ? areaCodeMap[areaCode] : { country: 'Canada', province: 'Ontario' };
            await db.collection('users').doc(from).set(
                {
                    user_id: from,
                    created_at: new Date().toISOString(),
                    onboarding_in_progress: true,
                    teamMembers: [],
                    country: location.country,
                    province: location[location.country === 'USA' ? 'state' : 'province']
                },
                { merge: true }
            );
            console.log(`[✅] Initial user profile created for ${from} with auto-detected ${location.country}/${location[location.country === 'USA' ? 'state' : 'province']}`);
            userProfile = await getUserProfile(from);
            ownerId = from;
        } else if (ownerInfo && !userProfile) {
            await db.collection('users').doc(from).set(
                {
                    user_id: from,
                    created_at: new Date().toISOString(),
                    onboarding_in_progress: true,
                    isTeamMember: true,
                    ownerId: ownerInfo.ownerId
                },
                { merge: true }
            );
            userProfile = await getUserProfile(from);
        }

        const contractorName = userProfile.name || 'Your Company Name';

        // Inner try for input processing
        try {
            let input = body;
            let type = 'expense';
            let reply;

            if (mediaUrl && mediaType) {
                const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
                const mediaContent = Buffer.from(response.data);

                if (mediaType.startsWith('image/')) {
                    input = await processDocumentAI(mediaContent);
                    type = 'expense';
                } else if (mediaType.startsWith('audio/')) {
                    input = await transcribeAudio(mediaContent);
                    type = input?.toLowerCase().includes('revenue') || input?.toLowerCase().includes('earned') ? 'revenue' : 'expense';
                }

                if (!input) {
                    return res.send(`<Response><Message>⚠️ Failed to process media. Please try again.</Message></Response>`);
                }
            } else if (!body) {
                return res.status(400).send("Bad Request: Missing 'Body' or media");
            } else {
                type = body.toLowerCase().includes('revenue') || body.toLowerCase().includes('earned') ? 'revenue' : 'expense';
            }

          // ONBOARDING FLOW
console.log(`[DEBUG] Entering onboarding flow for ${from}, profile:`, userProfile);

// Force onboarding to continue if user email is missing
if (!userProfile.email) {
  userProfile.onboarding_in_progress = true;
  console.log(`[DEBUG] Forcing onboarding for ${userProfile.user_id} due to missing email`);
  await saveUserProfile(userProfile);
}

if (userProfile.onboarding_in_progress) {
  let state = await getOnboardingState(from);
  const isTeamMember = userProfile.isTeamMember;

  console.log(`[DEBUG] Current onboarding state for ${from}:`, state);

  if (!state) {
    state = { step: 0, responses: {}, dynamicStep: null };
    await setOnboardingState(from, state);
    console.log(`[DEBUG] Starting onboarding for ${from}`);
    return res.send(`<Response><Message>Welcome! What's your name?</Message></Response>`);
  }

  const response = body.trim();
  const responseLower = response.toLowerCase();

  try {
    if (isTeamMember) {
      console.log(`[DEBUG] Team member onboarding not fully implemented for ${from}`);
      return res.send(`<Response><Message>Team member onboarding TBD</Message></Response>`);
    } else {
      // Owner onboarding
      if (state.step === 0) {
        console.log(`[DEBUG] Processing name response for ${from}: ${response}`);
        state.responses.name = response;
        state.step = 1;
        const { country, region } = detectCountryAndRegion(from);
        state.responses.detectedCountry = country;
        state.responses.detectedRegion = region;
        console.log(`[DEBUG] Setting onboarding state for ${from} to step 1`);
        await setOnboardingState(from, state);
        userProfile.name = response; // Fixed: Use userProfile instead of userProfileData
        console.log(`[DEBUG] Saving user profile for ${from} with name`);
        await saveUserProfile(userProfile);
        console.log(`[DEBUG] Detected location for ${from}: ${country}, ${region}`);
        const normalizePhoneNumber = (phone) =>
          phone.replace(/^whatsapp:/i, '').replace(/^\+/, '').trim();
        const fromNumber = `whatsapp:+${normalizePhoneNumber(process.env.TWILIO_WHATSAPP_NUMBER)}`;
        const messageBody = {
          MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
          To: `whatsapp:${from}`,
          From: fromNumber,
          ContentSid: "HX0280df498999848aaff04cc079e16c31",
          ContentVariables: JSON.stringify({
            1: country,
            2: region
          })
        };
        console.log(`[DEBUG] Sending location confirmation template to ${from} with payload:`, messageBody);
        const twilioResponse = await axios.post(
          `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
          new URLSearchParams(messageBody),
          {
            auth: {
              username: process.env.TWILIO_ACCOUNT_SID,
              password: process.env.TWILIO_AUTH_TOKEN
            },
            timeout: 5000
          }
        );
        console.log(`[DEBUG] Twilio API response:`, twilioResponse.data);
        return res.send(`<Response></Response>`);
      } else if (state.step === 1) {
        console.log(`[DEBUG] Processing location confirmation for ${from}: ${response}`);
        if (responseLower === 'yes') {
          userProfile.country = state.responses.detectedCountry;
          userProfile.province = state.responses.detectedRegion;
          state.step = 2;
          console.log(`[DEBUG] Setting onboarding state for ${from} to step 2`);
          await setOnboardingState(from, state);
          console.log(`[DEBUG] Saving user profile with location for ${from}`);
          await saveUserProfile(userProfile);
          console.log(`[DEBUG] Asking for email for ${from}`);
          return res.send(`<Response><Message>What’s your email address?</Message></Response>`);
        } else if (responseLower === 'edit') {
          console.log(`[DEBUG] User chose to edit location for ${from}`);
          return res.send(`<Response><Message>Please provide your country and state/province (e.g., "Canada, Ontario"):</Message></Response>`);
        } else if (responseLower === 'cancel') {
          console.log(`[DEBUG] User cancelled onboarding for ${from}`);
          userProfile.onboarding_in_progress = false;
          await saveUserProfile(userProfile);
          await deleteOnboardingState(from);
          return res.send(`<Response><Message>Onboarding cancelled. Send "Hi" to start again!</Message></Response>`);
        } else {
          const [correctedCountry, correctedRegion] = response.split(',').map(s => s.trim());
          if (correctedCountry && correctedRegion) {
            userProfile.country = correctedCountry;
            userProfile.province = correctedRegion;
            state.step = 2;
            console.log(`[DEBUG] Setting onboarding state for ${from} to step 2 with manual correction`);
            await setOnboardingState(from, state);
            await saveUserProfile(userProfile);
            console.log(`[DEBUG] Asking for email for ${from}`);
            return res.send(`<Response><Message>What’s your email address?</Message></Response>`);
          } else {
            return res.send(`<Response><Message>Invalid format. Use "Country, State/Province" or press a button.</Message></Response>`);
          }
        }
      } else if (state.step === 2) {
        console.log(`[DEBUG] Processing email response for ${from}: ${response}`);
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const trimmedEmail = response.trim();
        if (!emailRegex.test(trimmedEmail)) {
          console.log(`[DEBUG] Invalid email format provided by ${from}: ${trimmedEmail}`);
          return res.send(`<Response><Message>Please provide a valid email address.</Message></Response>`);
        }
        state.responses.email = trimmedEmail;
        state.step = 3;
        await setOnboardingState(from, state);
        userProfile.email = trimmedEmail;
        userProfile.onboarding_in_progress = false;
        console.log(`[DEBUG] Saving user profile with email for ${from}`);
        await saveUserProfile(userProfile);
        console.log(`[DEBUG] Getting or creating spreadsheet for ${from} with email: ${trimmedEmail}`);
        let spreadsheetResult;
        try {
          spreadsheetResult = await getOrCreateUserSpreadsheet(from, trimmedEmail);
          console.log(`[DEBUG] Spreadsheet result for ${from}:`, spreadsheetResult);
          if (!spreadsheetResult || !spreadsheetResult.spreadsheetId) {
            throw new Error('getOrCreateUserSpreadsheet returned no spreadsheetId');
          }
        } catch (error) {
          console.error(`[ERROR] Failed to get or create spreadsheet for ${from}:`, error.message);
          return res.send(`<Response><Message>Sorry, there was an issue setting up your spreadsheet. Please try again later.</Message></Response>`);
        }
        const { spreadsheetId } = spreadsheetResult;
        await deleteOnboardingState(from);
        const spreadsheetLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
        const normalizePhoneNumber = (phone) => phone.replace(/^whatsapp:/i, '').replace(/^\+/, '').trim();
        const fromNumber = `whatsapp:+${normalizePhoneNumber(process.env.TWILIO_WHATSAPP_NUMBER)}`;
        const messageBody = {
          MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
          To: `whatsapp:${from}`,
          From: fromNumber,
          ContentSid: "HXf5964d5ffeecc5e7f4e94d7b3379e084",
          ContentVariables: JSON.stringify({
            1: spreadsheetLink
          })
        };
        console.log(`[DEBUG] Sending spreadsheet link template to ${from}: ${spreadsheetLink}`);
        const twilioResponse = await axios.post(
          `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
          new URLSearchParams(messageBody),
          {
            auth: {
              username: process.env.TWILIO_ACCOUNT_SID,
              password: process.env.TWILIO_AUTH_TOKEN
            },
            timeout: 5000
          }
        );
        console.log(`[DEBUG] Twilio API response:`, twilioResponse.data);
        console.log(`[DEBUG] Onboarding complete for ${from}, spreadsheet ID: ${spreadsheetId}`);
        return res.send(`<Response></Response>`);
      } else {
        console.log(`[DEBUG] Unexpected onboarding step for ${from}: ${state.step}`);
        return res.send(`<Response><Message>Onboarding step out of sync. Please restart by saying "Hi".</Message></Response>`);
      }
    }
  } catch (error) {
    console.error(`[ERROR] Onboarding flow failed for ${from}:`, error.stack || error.message);
    throw new Error(`Inner webhook processing failed: ${error.message}`);
  }
} else {
  // NON-ONBOARDING FLOW
  let reply;
  const pendingState = await getPendingTransactionState(from);
  const spreadsheetId = userProfile.spreadsheetId; // Assuming ownerProfile is userProfile
  if (withinLimit.exceeded) {
    return res.send(`<Response><Message>⚠️ Trial limit reached! Reply 'Upgrade' to continue.</Message></Response>`);
  }
  if (!userProfile.name) { // Fixed: userName to userProfile.name
    return res.send(`<Response><Message>⚠️ Your name is missing. Please reply with your name to continue.</Message></Response>`);
  }

  // Dynamic Industry prompt (on first expense)
  if (!userProfile.industry && body && body.includes('$') && !state?.dynamicStep) {
    await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'industry' });
    reply = "Hey, what industry are you in? (e.g., Construction, Freelancer)";
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }
  if (state?.dynamicStep === 'industry') {
    userProfile.industry = response;
    await saveUserProfile(userProfile);
    reply = `Got it, ${userProfile.name}! Industry set to ${response}. Keep logging—next up, I’ll ask your financial goal when you add a bill or revenue.`;
    await deleteOnboardingState(from);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }

  // Dynamic Goal prompt (on first bill or revenue)
  if (!userProfile.goal && body && (body.toLowerCase().includes('bill') || body.toLowerCase().includes('revenue')) && !state?.dynamicStep) {
    await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'goal' });
    reply = "What’s your financial goal, boss? (e.g., Grow profit by $10,000, Pay off $5,000 debt)";
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }
  if (state?.dynamicStep === 'goal') {
    userProfile.goal = response;
    userProfile.goalProgress = { 
      target: response.includes('debt') ? -parseFloat(response.match(/\d+/)?.[0] || 5000) * 1000 : parseFloat(response.match(/\d+/)?.[0] || 10000) * 1000, 
      current: 0 
    };
    await saveUserProfile(userProfile);
    const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
    reply = `Goal locked in: "${response}" (${currency} ${userProfile.goalProgress.target.toFixed(2)}). You’re unstoppable, ${userProfile.name}! Check "Goal" anytime to track it.`;
    await deleteOnboardingState(from);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }

  // "team" command (single instance)
  if (body.toLowerCase() === "team") {
    const teamInfo = await getTeamInfo(from); // Fixed: ownerId to from
    if (teamInfo && teamInfo.teamMembers.length > 0) {
      reply = `Your team: ${teamInfo.teamMembers.map(m => `${m.name} (${m.phone})`).join(", ")}`;
    } else {
      reply = "No team members yet. Reply 'Add [name] [phone]' to add one.";
    }
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }


                // Existing branches
                if (body.toLowerCase().startsWith("add ")) {
                    const addMatch = body.match(/add\s+(.+?)\s+\+(\d{10,11})\s+as\s+a\s+team\s+member/i);
                    if (addMatch) {
                        const newMemberPhone = normalizePhoneNumber(addMatch[2]);
                        await db.collection('users').doc(ownerId).update({
                            teamMembers: admin.firestore.FieldValue.arrayUnion({
                                phone: newMemberPhone,
                                name: addMatch[1],
                                added_at: new Date().toISOString()
                            })
                        });
                        reply = `✅ Added ${addMatch[1]} (${newMemberPhone}) to your team.`;
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                }
                
                // Edit bill command
                if (body.toLowerCase().startsWith("edit bill ")) {
                    if (!isOwner) {
                        return res.send(`<Response><Message>⚠️ Only the owner can edit bills.</Message></Response>`);
                    }
                    const match = body.match(/edit bill\s+(.+?)(?:\s+amount\s+(\$?\d+\.?\d*))?(?:\s+due\s+(.+?))?(?:\s+(yearly|monthly|weekly|bi-weekly|one-time))?/i);
                    if (!match) {
                        return res.send(`<Response><Message>⚠️ Format: "Edit bill [name] [amount $X] [due date] [recurrence]" (e.g., "Edit bill Rent amount $600 due June 1st monthly")</Message></Response>`);
                    }
                    const [, billName, amount, dueDate, recurrence] = match;
                    const billData = {
                        billName,
                        date: new Date().toISOString().split('T')[0],
                        amount: amount ? `$${parseFloat(amount.replace('$', '')).toFixed(2)}` : null,
                        dueDate: dueDate || null,
                        recurrence: recurrence || null
                    };
                    const success = await updateBillInSheets(ownerId, billData);
                    reply = success 
                        ? `✅ Bill "${billName}" updated${amount ? ` to ${billData.amount}` : ''}${dueDate ? ` due ${dueDate}` : ''}${recurrence ? ` (${recurrence})` : ''}.`
                        : `⚠️ Bill "${billName}" not found or update failed.`;
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }

                // Delete bill command (standalone version)
                if (body.toLowerCase().startsWith("delete bill ")) {
                    if (!isOwner) {
                        return res.send(`<Response><Message>⚠️ Only the owner can delete bills.</Message></Response>`);
                    }
                    const billName = body.replace(/^delete bill\s+/i, '').trim();
                    await setPendingTransactionState(from, { pendingDelete: { type: 'bill', billName } });
                    return res.send(`<Response><Message>Are you sure you want to delete bill "${billName}"? Reply 'yes' or 'no'.</Message></Response>`);
                }

                // Enhance existing pending delete confirmation for bills
                if (pendingState && pendingState.pendingDelete) {
                    if (!isOwner) {
                        await deletePendingTransactionState(from);
                        return res.send(`<Response><Message>⚠️ Only the owner can delete entries.</Message></Response>`);
                    }
                    if (input.toLowerCase() === 'yes') {
                        const { type, billName, rowIndex } = pendingState.pendingDelete;
                        if (type === 'bill') {
                            const success = await deleteBillInSheets(ownerId, billName);
                            reply = success ? `✅ Bill "${billName}" deleted.` : `⚠️ Bill "${billName}" not found or deletion We failed.`;
                        } else {
                            const sheets = google.sheets({ version: 'v4', auth: await getAuthorizedClient() });
                            const sheetName = type === 'revenue' ? 'Revenue' : 'Sheet1';
                            await sheets.spreadsheets.values.update({
                                spreadsheetId,
                                range: `${sheetName}!A${rowIndex + 2}:I${rowIndex + 2}`,
                                valueInputOption: 'RAW',
                                resource: { values: [[]] }
                            });
                            reply = `✅ Deleted ${type} entry successfully.`;
                        }
                        await deletePendingTransactionState(from);
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    } else if (input.toLowerCase() === 'no' || input.toLowerCase() === 'cancel') {
                        await deletePendingTransactionState(from);
                        reply = "❌ Deletion cancelled.";
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    } else {
                        reply = "⚠️ Please reply with 'yes' or 'no' to confirm deletion.";
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                }

                // 0. Team Management Commands (Owner Only)
                if (isOwner && input.toLowerCase().startsWith("add ")) {
                    const addMatch = input.match(/add\s+(.+?)\s+\+(\d{10,11})\s+as\s+a\s+team\s+member/i);
                    if (addMatch) {
                        const memberName = addMatch[1].trim();
                        const memberPhone = addMatch[2];
                        await addTeamMember(from, memberName, memberPhone);
                        const sent = await sendTemplateMessage(
                            memberPhone,
                            confirmationTemplates.teamMemberInvite,
                            [
                                { type: "text", text: memberName },
                                { type: "text", text: ownerProfile.name }
                            ]
                        );
                        reply = sent
                            ? `✅ Invited ${memberName} (${memberPhone}) to your team. They’ll need to reply with their name to join.`
                            : `✅ Added ${memberName} (${memberPhone}) to your team, but couldn’t send the invite message.`;
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                    return res.send(`<Response><Message>⚠️ Invalid format. Use: "Add John Doe +19058884444 as a team member"</Message></Response>`);
                } else if (isOwner && input.toLowerCase().startsWith("remove ")) {
                    const removeMatch = input.match(/remove\s+\+(\d{10,11})\s+from\s+my\s+team/i);
                    if (removeMatch) {
                        const memberPhone = removeMatch[1];
                        await removeTeamMember(from, memberPhone);
                        return res.send(`<Response><Message>✅ Removed ${memberPhone} from your team.</Message></Response>`);
                    }
                    return res.send(`<Response><Message>⚠️ Invalid format. Use: "Remove +19058884444 from my team"</Message></Response>`);
                } else if (!isOwner && (input.toLowerCase().startsWith("add ") || input.toLowerCase().startsWith("remove "))) {
                    return res.send(`<Response><Message>⚠️ Only the owner can manage team members.</Message></Response>`);
                }

                // 1. Pending Delete Confirmation
                if (pendingState && pendingState.pendingDelete) {
                    if (!isOwner) {
                        await deletePendingTransactionState(from);
                        return res.send(`<Response><Message>⚠️ Only the owner can delete entries.</Message></Response>`);
                    }
                    if (input.toLowerCase() === 'yes') {
                        const { type, rowIndex, sheetName } = pendingState.pendingDelete;
                        const auth = await getAuthorizedClient();
                        const sheets = google.sheets({ version: 'v4', auth });

                        await sheets.spreadsheets.values.update({
                            spreadsheetId,
                            range: `${sheetName}!A${rowIndex + 2}:I${rowIndex + 2}`,
                            valueInputOption: 'RAW',
                            resource: { values: [[]] }
                        });

                        await deletePendingTransactionState(from);
                        reply = `✅ Deleted ${type} entry successfully.`;
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    } else if (input.toLowerCase() === 'no' || input.toLowerCase() === 'cancel') {
                        await deletePendingTransactionState(from);
                        reply = "❌ Deletion cancelled.";
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    } else {
                        reply = "⚠️ Please reply with 'yes' or 'no' to confirm deletion.";
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                }

                // 2. Pending Quote Handling (Owner Only)
                if (pendingState && pendingState.pendingQuote) {
                    if (!isOwner) {
                        await deletePendingTransactionState(from);
                        return res.send(`<Response><Message>⚠️ Only the owner can generate quotes.</Message></Response>`);
                    }
                    const { jobName, items, total, isFixedPrice, description } = pendingState.pendingQuote;
                    const customerInput = input.trim();
                    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    const customerName = emailRegex.test(customerInput) ? 'Email Provided' : customerInput;
                    const customerEmail = emailRegex.test(customerInput) ? customerInput : null;

                    const taxRate = getTaxRate(userProfileData.country, userProfileData.province); // #5
                    const subtotal = total;
                    const tax = subtotal * taxRate;
                    const totalWithTax = subtotal + tax;
                    const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD'; // #5

                    const outputPath = `/tmp/quote_${from}_${Date.now()}.pdf`;
                    const quoteData = {
                        jobName,
                        items: isFixedPrice ? [{ item: description, quantity: 1, price: subtotal }] : items,
                        subtotal,
                        tax,
                        total: totalWithTax,
                        customerName,
                        contractorName: ownerProfile.name || 'Your Company Name',
                        companyName: ownerProfile.companyName || '',
                        hstNumber: ownerProfile.hstNumber || '',
                        companyAddress: ownerProfile.companyAddress || '',
                        companyPhone: ownerProfile.companyPhone || '',
                        logoUrl: ownerProfile.logoUrl || '',
                        paymentTerms: ownerProfile.paymentTerms || 'Due upon receipt',
                        specialMessage: ownerProfile.specialMessage || 'Thank you for your business!'
                    };
                    await generateQuotePDF(quoteData, outputPath);

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

                    await deletePendingTransactionState(from);

                    reply = `✅ Quote for ${jobName} generated.\nSubtotal: ${currency} ${subtotal.toFixed(2)}\nTax (${(taxRate * 100).toFixed(2)}%): ${currency} ${tax.toFixed(2)}\nTotal: ${currency} ${totalWithTax.toFixed(2)}\nCustomer: ${customerName}\nDownload here: ${pdfUrl}`; // #5 Updated
                    if (customerEmail) {
                        await sendSpreadsheetEmail(customerEmail, driveResponse.data.id, 'Your Quote');
                        reply += `\nAlso sent to ${customerEmail}`;
                    }
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }

                // 3. Chief Message Handling
                if (input.toLowerCase() === "chief!!") {
                    await setPendingTransactionState(from, { pendingChiefMessage: true });
                    return res.send(`<Response><Message>Please write your message for Scott, and I'll send it to him!</Message></Response>`);
                }
                else if (pendingState && pendingState.pendingChiefMessage) {
                    const userMessage = input.trim();
                    const senderName = userName || 'Unknown User';
                    const senderPhone = from;

                    try {
                        await sendEmail({
                            to: 'scottejutras@gmail.com',
                            from: 'scott@scottjutras.com',
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

                // 4. Pending Confirmations for Expense, Revenue, or Bill
                if (pendingState && (pendingState.pendingExpense || pendingState.pendingRevenue || pendingState.pendingBill)) {
                    const pendingData = pendingState.pendingExpense || pendingState.pendingRevenue || pendingState.pendingBill;
                    const type = pendingState.pendingExpense ? 'expense' : pendingState.pendingRevenue ? 'revenue' : 'bill';
                    const activeJob = await getActiveJob(ownerId) || "Uncategorized";

                    if (input && input.toLowerCase() === 'yes') {
                        const category = pendingData.suggestedCategory || await categorizeEntry(type, pendingData, ownerProfile);
                        if (type === 'expense') {
                            await appendToUserSpreadsheet(ownerId, [pendingData.date, pendingData.item, pendingData.amount, pendingData.store, activeJob, 'expense', category, mediaUrl || '', userName]);
                        } else if (type === 'revenue') {
                            await appendToUserSpreadsheet(ownerId, [pendingData.date, pendingData.description, pendingData.amount, pendingData.source || pendingData.client, activeJob, 'revenue', category, '', userName]);
                        } else if (type === 'bill') {
                            await appendToUserSpreadsheet(ownerId, [pendingData.date, pendingData.billName, pendingData.amount, pendingData.recurrence, activeJob, 'bill', category, '', userName]);
                        }
                        await deletePendingTransactionState(from);
                        reply = `✅ ${type} logged: ${pendingData.amount} ${type === 'expense' ? `for ${pendingData.item} from ${pendingData.store}` : type === 'revenue' ? `from ${pendingData.source || pendingData.client}` : `for ${pendingData.billName}`} on ${pendingData.date} by ${userName} (Category: ${category})`;
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    } else if (input && (input.toLowerCase() === 'no' || input.toLowerCase() === 'edit')) {
                        reply = "✏️ Okay, please resend the correct details.";
                        await setPendingTransactionState(from, { isEditing: true, type });
                        await deletePendingTransactionState(from);
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    } else if (input && input.toLowerCase() === 'cancel') {
                        await deletePendingTransactionState(from);
                        reply = "❌ Transaction cancelled.";
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    } else {
                        const errors = detectErrors(pendingData, type);
                        const category = await categorizeEntry(type, pendingData, ownerProfile);
                        pendingData.suggestedCategory = category;
                        if (errors) {
                            const corrections = await correctErrorsWithAI(errors);
                            if (corrections) {
                                await setPendingTransactionState(from, {
                                    [type === 'expense' ? 'pendingExpense' : type === 'revenue' ? 'pendingRevenue' : 'pendingBill']: pendingData,
                                    pendingCorrection: true,
                                    suggestedCorrections: corrections,
                                    type
                                });
                                const correctionText = Object.entries(corrections).map(([k, v]) => `${k}: ${pendingData[k] || 'missing'} → ${v}`).join('\n');
                                reply = `🤔 Issues detected:\n${correctionText}\nReply 'yes' to accept or 'no' to edit.\nSuggested Category: ${category}`;
                                return res.send(`<Response><Message>${reply}</Message></Response>`);
                            }
                        }
                        reply = `⚠️ Please respond with 'yes', 'no', 'edit', or 'cancel' to proceed.\nSuggested Category: ${category}`;
                        const sent = await sendTemplateMessage(
                            from,
                            type === 'expense' || type === 'bill' ? confirmationTemplates.expense : confirmationTemplates.revenue,
                            { "1": `Please confirm: ${type === 'expense' || type === 'bill' ? `${pendingData.amount} for ${pendingData.item || pendingData.source || pendingData.billName} on ${pendingData.date}` : `Revenue of ${pendingData.amount} from ${pendingData.source} on ${pendingData.date}`} (Category: ${category})` }
                        );
                        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                }

                // 5. Start Job Command (Owner Only)
                else if (input && /^(start job|job start)\s+(.+)/i.test(input)) {
                    if (!isOwner) {
                        return res.send(`<Response><Message>⚠️ Only the owner can start jobs.</Message></Response>`);
                    }
                    const defaultData = { jobName: "Unknown Job" };
                    const { data, reply, confirmed } = await handleInputWithAI(
                        from,
                        input,
                        'job',
                        (input) => {
                            const match = input.match(/^(start job|job start)\s+(.+)/i);
                            return match ? { jobName: match[2].trim() } : null;
                        },
                        defaultData
                    );

                    if (reply) {
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }

                    if (data && data.jobName && confirmed) {
                        await setActiveJob(from, data.jobName);
                        const sent = await sendTemplateMessage(from, confirmationTemplates.startJob, [{ type: "text", text: data.jobName }]);
                        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>✅ Job '${data.jobName}' started.</Message></Response>`);
                    }
                }

                // 6. Finish Job Command (Owner Only)
                else if (input && input.toLowerCase().startsWith("finish job ")) {
                    if (!isOwner) {
                        return res.send(`<Response><Message>⚠️ Only the owner can finish jobs.</Message></Response>`);
                    }
                    const jobName = input.replace(/^finish job\s+/i, '').trim();
                    const activeJob = await getActiveJob(ownerId);
                    if (activeJob !== jobName) {
                        return res.send(`<Response><Message>⚠️ No active job named '${jobName}'.</Message></Response>`);
                    }
                    await finishJob(ownerId, jobName);
                    const userRef = db.collection('users').doc(ownerId);
                    const doc = await userRef.get();
                    const job = doc.data().jobHistory.find(j => j.jobName === jobName);
                    const durationDays = Math.round((new Date(job.endTime) - new Date(job.startTime)) / (1000 * 60 * 60 * 24));
                    const sheets = google.sheets({ version: 'v4', auth: await getAuthorizedClient() });
                    const expenseData = await sheets.spreadsheets.values.get({
                        spreadsheetId: ownerProfile.spreadsheetId,
                        range: 'Sheet1!A:I'
                    });
                    const revenueData = await sheets.spreadsheets.values.get({
                        spreadsheetId: ownerProfile.spreadsheetId,
                        range: 'Revenue!A:I'
                    });
                    const expenses = expenseData.data.values.slice(1).filter(row => row[4] === jobName);
                    const revenues = revenueData.data.values.slice(1).filter(row => row[4] === jobName);
                    const totalExpenses = expenses.reduce((sum, row) => sum + parseFloat(row[2].replace('$', '')), 0);
                    const totalRevenue = revenues.reduce((sum, row) => sum + parseFloat(row[2].replace('$', '')), 0);
                    const profit = totalRevenue - totalExpenses;
                    const profitPerDay = profit / durationDays || 0;
                    const revenuePerDay = totalRevenue / durationDays || 0;
                    const hoursWorked = durationDays * 8;
                    const profitPerHour = profit / hoursWorked || 0;
                    reply = `✅ Job '${jobName}' finished after ${durationDays} days.\nRevenue: $${revenuePerDay.toFixed(2)}/day\nProfit: $${profitPerDay.toFixed(2)}/day\nHourly Profit: $${profitPerHour.toFixed(2)}/hour`;
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }

                // 7. Add, Update and Delete Bill Command
            if (input && input.toLowerCase().includes("bill") && !input.toLowerCase().includes("delete")) {
                console.log("[DEBUG] Detected a bill message:", input);
                const activeJob = await getActiveJob(ownerId) || "Uncategorized";
                const defaultData = { date: new Date().toISOString().split('T')[0], billName: "Unknown", amount: "$0.00", recurrence: "one-time", dueDate: "Unknown" };

                let state = await getOnboardingState(from);
                if (!userProfileData.goal && !state?.dynamicStep) {
                    await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'goal' });
                    reply = "What’s your financial goal, boss? (e.g., Grow profit by $10,000, Pay off $5,000 debt)";
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                if (state?.dynamicStep === 'goal') {
                    userProfileData.goal = input;
                    if (!input.match(/\d+/) || (!input.includes('profit') && !input.includes('debt'))) {
                        reply = "⚠️ That doesn’t look like a goal. Try 'Grow profit by $10,000' or 'Pay off $5,000 debt'.";
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                    userProfileData.goalProgress = { 
                        target: input.includes('debt') ? -parseFloat(input.match(/\d+/)?.[0] || 5000) * 1000 : parseFloat(input.match(/\d+/)?.[0] || 10000) * 1000, 
                        current: 0 
                    };
                    await saveUserProfile(userProfileData);
                    const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
                    reply = `Goal locked in: "${input}" (${currency} ${userProfileData.goalProgress.target.toFixed(2)}). You’re unstoppable, ${userProfileData.name}!`;
                    await deleteOnboardingState(from);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }

                const { data, reply: aiReply, confirmed } = await handleInputWithAI(
                    from,
                    input,
                    'bill',
                    (input) => {
                        const billRegex = /bill\s+([\w\s]+)\s+\$([\d,]+(?:\.\d{1,2})?)\s+(?:per\s+)?(\w+)?\s*(?:on|due)\s+([\w\d\s,-]+)/i;
                        const match = input.match(billRegex);
                        if (match) {
                            return {
                                date: new Date().toISOString().split('T')[0],
                                billName: match[1].trim(),
                                amount: `$${parseFloat(match[2].replace(/,/g, '')).toFixed(2)}`,
                                recurrence: match[3] ? (match[3].toLowerCase() === "month" ? "monthly" : match[3]) : "one-time",
                                dueDate: match[4].trim()
                            };
                        }
                        return null;
                    },
                    defaultData
                );

                if (aiReply) {
                    return res.send(`<Response><Message>${aiReply}</Message></Response>`);
                }

                if (data && data.billName && data.amount && data.amount !== "$0.00" && data.dueDate && confirmed) {
                    const refinedDueDate = data.dueDate.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})/i)
                        ? `${data.dueDate.match(/(\w+)/)[1]} ${parseInt(data.dueDate.match(/(\d{1,2})/)[1]) === 1 ? "1st" : "2nd"}`
                        : data.dueDate;
                    const category = await categorizeEntry('bill', data, ownerProfile);
                    await setPendingTransactionState(from, { pendingBill: { ...data, dueDate: refinedDueDate, suggestedCategory: category } });
                    const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
                    const sent = await sendTemplateMessage(from, confirmationTemplates.bill, {
                        "1": `${currency} ${parseFloat(data.amount.replace(/[^0-9.]/g, '')).toFixed(2)}`,
                        "2": refinedDueDate,
                        "3": data.recurrence.charAt(0).toUpperCase() + data.recurrence.slice(1)
                    });
                    return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>⚠️ Failed to send bill confirmation.</Message></Response>`);
                }
            }

            // 8. Revenue Logging Branch
            else if (input && input.toLowerCase().includes("received")) {
                console.log("[DEBUG] Detected a revenue message:", input);
                const activeJob = await getActiveJob(ownerId) || "Uncategorized";
                const defaultData = { date: new Date().toISOString().split('T')[0], description: "Payment", amount: "$0.00", source: "Unknown Client" };

                let state = await getOnboardingState(from);
                if (!userProfileData.goal && !state?.dynamicStep) {
                    await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'goal' });
                    reply = "What’s your financial goal, boss? (e.g., Grow profit by $10,000, Pay off $5,000 debt)";
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                if (state?.dynamicStep === 'goal') {
                    userProfileData.goal = input;
                    userProfileData.goalProgress = { 
                        target: input.includes('debt') ? -parseFloat(input.match(/\d+/)?.[0] || 5000) * 1000 : parseFloat(input.match(/\d+/)?.[0] || 10000) * 1000, 
                        current: 0 
                    };
                    await saveUserProfile(userProfileData);
                    const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
                    reply = `Goal locked in: "${input}" (${currency} ${userProfileData.goalProgress.target.toFixed(2)}). You’re unstoppable, ${userProfileData.name}! Now, let’s log that revenue.`;
                    await deleteOnboardingState(from);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }

                const { data, reply: aiReply, confirmed } = await handleInputWithAI(from, input, 'revenue', parseRevenueMessage, defaultData);

                if (aiReply) {
                    return res.send(`<Response><Message>${aiReply}</Message></Response>`);
                }

                if (data && data.amount && data.amount !== "$0.00") {
                    const category = await categorizeEntry('revenue', data, ownerProfile);
                    data.suggestedCategory = category;
                    const taxRate = getTaxRate(userProfileData.country, userProfileData.province);
                    const amount = parseFloat(data.amount.replace(/[^0-9.]/g, ''));
                    const taxAmount = amount * taxRate;
                    const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';

                    if (confirmed) {
                        reply = await appendToUserSpreadsheet(ownerId, [data.date, data.description, data.amount, data.source || data.client, activeJob, 'revenue', category, '', userName]);
                        reply += `. Tax: ${currency} ${taxAmount.toFixed(2)} (${(taxRate * 100).toFixed(2)}%)`;
                        return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
                    } else {
                        await setPendingTransactionState(from, { pendingRevenue: data });
                        reply = `Revenue: ${currency} ${amount.toFixed(2)} from ${data.source || data.client}. Tax: ${currency} ${taxAmount.toFixed(2)} (${(taxRate * 100).toFixed(2)}%)`;
                        const sent = await sendTemplateMessage(from, confirmationTemplates.revenue, {
                            "1": `${reply} on ${data.date} (Category: ${category})`
                        });
                        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>⚠️ Failed to send revenue confirmation.</Message></Response>`);
                    }
                }
            }

            // Quick Matches for Expense, Revenue, Bill
            else if (input) {
                const expenseMatch = input.match(/^(?:expense\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
                const revenueMatch = input.match(/^(?:revenue\s+)?(?:received\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(?:from\s+)?(.+)/i);
                const billMatch = input.match(/^bill\s+(.+?)\s+\$?(\d+(?:\.\d{1,2})?)\s+(yearly|monthly|weekly|bi-weekly|one-time)$/i);

                let state = await getOnboardingState(from);
                if (expenseMatch && !userProfileData.industry && !state?.dynamicStep) {
                    await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'industry' });
                    reply = "Hey, what industry are you in? (e.g., Construction, Freelancer)";
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                if (state?.dynamicStep === 'industry') {
                    userProfileData.industry = input;
                    await saveUserProfile(userProfileData);
                    reply = `Got it, ${userProfileData.name}! Industry set to ${input}. Keep logging—next up, I’ll ask your financial goal when you add a bill or revenue.`;
                    await deleteOnboardingState(from);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                if (billMatch && !userProfileData.goal && !state?.dynamicStep) {
                    await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'goal' });
                    reply = "What’s your financial goal, boss? (e.g., Grow profit by $10,000, Pay off $5,000 debt)";
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                if (state?.dynamicStep === 'goal') {
                    userProfileData.goal = input;
                    userProfileData.goalProgress = { 
                        target: input.includes('debt') ? -parseFloat(input.match(/\d+/)?.[0] || 5000) * 1000 : parseFloat(input.match(/\d+/)?.[0] || 10000) * 1000, 
                        current: 0 
                    };
                    await saveUserProfile(userProfileData);
                    const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
                    reply = `Goal locked in: "${input}" (${currency} ${userProfileData.goalProgress.target.toFixed(2)}). You’re unstoppable, ${userProfileData.name}!`;
                    await deleteOnboardingState(from);
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }

                if (expenseMatch) {
                    const [, amount, item, store] = expenseMatch;
                    const date = new Date().toISOString().slice(0, 10);
                    const activeJob = await getActiveJob(ownerId) || "Uncategorized";
                    const category = await categorizeEntry('expense', { amount, item, store, date }, ownerProfile);
                    reply = await appendToUserSpreadsheet(ownerId, [date, item, amount, store || '', activeJob, 'expense', category, mediaUrl || '', userName]);
                    return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
                } else if (revenueMatch) {
                    const [, amount, source] = revenueMatch;
                    const date = new Date().toISOString().slice(0, 10);
                    const activeJob = await getActiveJob(ownerId) || "Uncategorized";
                    const category = await categorizeEntry('revenue', { amount, description: source, date }, ownerProfile);
                    reply = await appendToUserSpreadsheet(ownerId, [date, source, amount, source, activeJob, 'revenue', category, '', userName]);
                    return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
                } else if (billMatch) {
                    const [, billName, amount, recurrence] = billMatch;
                    const date = new Date().toISOString().slice(0, 10);
                    const activeJob = await getActiveJob(ownerId) || "Uncategorized";
                    const category = await categorizeEntry('bill', { billName, amount, recurrence, date }, ownerProfile);
                    reply = await appendToUserSpreadsheet(ownerId, [date, billName, amount, recurrence, activeJob, 'bill', category, '', userName]);
                    return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
                }
            }

            // Additional Commands (#5 UX Polish)
            if (input.toLowerCase().startsWith("stats")) {
                try {
                    const sheets = google.sheets({ version: 'v4', auth: await getAuthorizedClient() });
                    const expenses = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Sheet1!A:I' });
                    const revenues = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Revenue!A:I' });
                    const expenseData = expenses.data.values?.slice(1).filter(row => row[5] === 'expense') || [];
                    const revenueData = revenues.data.values?.slice(1) || [];
                    const totalExpenses = expenseData.reduce((sum, row) => sum + parseFloat(row[2].replace(/[^0-9.]/g, '') || 0), 0);
                    const totalRevenue = revenueData.reduce((sum, row) => sum + parseFloat(row[2].replace(/[^0-9.]/g, '') || 0), 0);
                    const profit = totalRevenue - totalExpenses;
                    const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
                    reply = `📊 Your Stats, ${userName}:\nRevenue: ${currency} ${totalRevenue.toFixed(2)}\nExpenses: ${currency} ${totalExpenses.toFixed(2)}\nProfit: ${currency} ${profit.toFixed(2)}`;
                    if (userProfileData.goalProgress) {
                        reply += `\nGoal Progress: ${currency} ${userProfileData.goalProgress.current.toFixed(2)} / ${userProfileData.goalProgress.target.toFixed(2)} (${((userProfileData.goalProgress.current / userProfileData.goalProgress.target) * 100).toFixed(1)}%)`;
                    }
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                } catch (error) {
                    console.error("[ERROR] Stats failed:", error.message);
                    return res.send(`<Response><Message>⚠️ Couldn’t fetch stats. Try again.</Message></Response>`);
                }
            }
    
                // 9. Delete Function for Revenue, Expense, Job, Bill (Owner Only)
                else if (input && (input.toLowerCase().includes("delete") || input.toLowerCase().includes("remove"))) {
                    if (!isOwner) {
                        return res.send(`<Response><Message>⚠️ Only the owner can delete entries.</Message></Response>`);
                    }
                    console.log("[DEBUG] Detected delete request:", input);

                    const auth = await getAuthorizedClient();
                    const sheets = google.sheets({ version: 'v4', auth });

                    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                    const gptResponse = await openaiClient.chat.completions.create({
                        model: "gpt-3.5-turbo",
                        messages: [
                            { role: "system", content: `Parse a delete request: "${input}". Return JSON: { type: 'revenue|expense|job|bill', criteria: { item: 'string|null', amount: 'string|null', date: 'string|null', store: 'string|null', source: 'string|null', billName: 'string|null', jobName: 'string|null' } }. Set unmatched fields to null.` },
                            { role: "user", content: input }
                        ],
                        max_tokens: 150,
                        temperature: 0.3
                    });
                    const deleteRequest = JSON.parse(gptResponse.choices[0].message.content);
                    console.log("[DEBUG] Delete request parsed:", deleteRequest);

                    let sheetName, range, data;
                    if (deleteRequest.type === 'revenue') {
                        sheetName = 'Revenue';
                        range = 'Revenue!A:F';
                    } else {
                        sheetName = 'Sheet1';
                        range = 'Sheet1!A:I';
                    }

                    try {
                        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
                        data = (response.data.values || []).slice(1);
                    } catch (error) {
                        console.error("[ERROR] Failed to fetch data for deletion:", error);
                        return res.send(`<Response><Message>⚠️ Could not retrieve your data. Please try again later.</Message></Response>`);
                    }

                    const matches = data.map((row, index) => ({ row, index })).filter(({ row }) => {
                        if (deleteRequest.type === 'revenue' && row[5] !== 'revenue') return false;
                        if (deleteRequest.type === 'expense' && row[5] !== 'expense') return false;
                        if (deleteRequest.type === 'bill' && row[5] !== 'bill') return false;
                        if (deleteRequest.type === 'job' && row[4] !== deleteRequest.criteria.jobName) return false;

                        const [date, itemOrDesc, amount, storeOrSource, , type] = row;
                        return (
                            (!deleteRequest.criteria.item || itemOrDesc.toLowerCase().includes(deleteRequest.criteria.item?.toLowerCase())) &&
                            (!deleteRequest.criteria.amount || amount.toLowerCase().includes(deleteRequest.criteria.amount?.toLowerCase())) &&
                            (!deleteRequest.criteria.date || date.toLowerCase().includes(deleteRequest.criteria.date?.toLowerCase())) &&
                            (!deleteRequest.criteria.store || storeOrSource?.toLowerCase().includes(deleteRequest.criteria.store?.toLowerCase())) &&
                            (!deleteRequest.criteria.source || storeOrSource?.toLowerCase().includes(deleteRequest.criteria.source?.toLowerCase())) &&
                            (!deleteRequest.criteria.billName || itemOrDesc.toLowerCase().includes(deleteRequest.criteria.billName?.toLowerCase())) &&
                            (!deleteRequest.criteria.jobName || row[4]?.toLowerCase() === deleteRequest.criteria.jobName?.toLowerCase())
                        );
                    });

                    if (matches.length === 0) {
                        return res.send(`<Response><Message>🤔 No ${deleteRequest.type} entries found matching "${input}". Try providing more details.</Message></Response>`);
                    } else if (matches.length === 1) {
                        const { row, index } = matches[0];
                        const [date, itemOrDesc, amount, storeOrSource] = row;
                        const summary = `${deleteRequest.type === 'expense' ? `${amount} for ${itemOrDesc} from ${storeOrSource}` : deleteRequest.type === 'revenue' ? `${amount} from ${storeOrSource}` : deleteRequest.type === 'bill' ? `${amount} for ${itemOrDesc}` : `job ${deleteRequest.criteria.jobName}`} on ${date}`;
                        await setPendingTransactionState(from, { pendingDelete: { type: deleteRequest.type, rowIndex: index, sheetName } });
                        const sent = await sendTemplateMessage(from, confirmationTemplates.deleteConfirmation, {
                            "1": `Are you sure you want to delete this ${deleteRequest.type}: ${summary}? Reply 'yes' or 'no'.`
                        });
                        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>Are you sure you want to delete this ${deleteRequest.type}: ${summary}? Reply 'yes' or 'no'.</Message></Response>`);
                    } else {
                        reply = `🤔 Found ${matches.length} matching ${deleteRequest.type} entries:\n`;
                        matches.slice(0, 3).forEach(({ row }, i) => {
                            const [date, itemOrDesc, amount, storeOrSource] = row;
                            reply += `${i + 1}. ${date} - ${itemOrDesc} (${amount}) ${storeOrSource ? `from ${storeOrSource}` : ''}\n`;
                        });
                        if (matches.length > 3) reply += `...and ${matches.length - 3} more. Please refine your request.`;
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                }

                // 10. Receipt Finder Feature
                else if (input && (input.toLowerCase().includes("find receipt") || input.toLowerCase().includes("where’s my receipt") || input.toLowerCase().includes("show me the receipt"))) {
                    console.log("[DEBUG] Detected receipt finder request:", input);

                    if (!spreadsheetId) {
                        return res.send(`<Response><Message>⚠️ No spreadsheet found for your team. Please contact the owner.</Message></Response>`);
                    }

                    const auth = await getAuthorizedClient();
                    const sheets = google.sheets({ version: 'v4', auth });
                    const expenseRange = 'Sheet1!A:I';
                    let expenses = [];
                    try {
                        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: expenseRange });
                        expenses = (response.data.values || []).slice(1).filter(row => row[5] === "expense");
                    } catch (error) {
                        console.error("[ERROR] Failed to fetch expense data:", error);
                        return res.send(`<Response><Message>⚠️ Could not retrieve your receipts. Please try again later.</Message></Response>`);
                    }

                    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                    const gptResponse = await openaiClient.chat.completions.create({
                        model: "gpt-3.5-turbo",
                        messages: [
                            { role: "system", content: `Parse a receipt-finding request: "${input}". Return JSON: { item: 'string|null', store: 'string|null', date: 'string|null', amount: 'string|null' }. Set unmatched fields to null.` },
                            { role: "user", content: input }
                        ],
                        max_tokens: 100,
                        temperature: 0.3
                    });
                    const searchCriteria = JSON.parse(gptResponse.choices[0].message.content);
                    console.log("[DEBUG] Search criteria:", searchCriteria);

                    const matches = expenses.filter(row => {
                        const [date, item, amount, store] = row;
                        return (
                            (!searchCriteria.item || item.toLowerCase().includes(searchCriteria.item.toLowerCase())) &&
                            (!searchCriteria.store || store.toLowerCase().includes(searchCriteria.store.toLowerCase())) &&
                            (!searchCriteria.date || date.toLowerCase().includes(searchCriteria.date.toLowerCase())) &&
                            (!searchCriteria.amount || amount.toLowerCase().includes(searchCriteria.amount.toLowerCase()))
                        );
                    });

                    if (matches.length === 0) {
                        return res.send(`<Response><Message>🤔 No receipts found matching "${input}". Try providing more details (e.g., item, store, date).</Message></Response>`);
                    } else if (matches.length === 1) {
                        const [date, item, amount, store, , , , imageUrl, loggedBy] = matches[0];
                        reply = `✅ Found your receipt:\n- Date: ${date}\n- Item: ${item}\n- Amount: ${amount}\n- Store: ${store}\n- Logged By: ${loggedBy}`;
                        if (imageUrl) reply += `\n- Image: ${imageUrl}`;
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    } else {
                        reply = `✅ Found ${matches.length} matching receipts:\n`;
                        matches.slice(0, 3).forEach(([date, item, amount, store, , , , , loggedBy], i) => {
                            reply += `${i + 1}. ${date} - ${item} (${amount}) from ${store} by ${loggedBy}\n`;
                        });
                        if (matches.length > 3) reply += `...and ${matches.length - 3} more. Refine your request for details.`;
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                }

                // 11. Metrics Queries (Owner Only)
                else if (input && (input.toLowerCase().includes("how much") ||
                    input.toLowerCase().includes("profit") ||
                    input.toLowerCase().includes("margin") ||
                    input.toLowerCase().includes("spend") ||
                    input.toLowerCase().includes("spent") ||
                    (input.toLowerCase().includes("how about") && (await getLastQuery(from))?.intent))) {
                    if (!isOwner) {
                        return res.send(`<Response><Message>⚠️ Only the owner can view metrics.</Message></Response>`);
                    }
                    console.log("[DEBUG] Detected a metrics query:", input);
                    const activeJob = await getActiveJob(ownerId) || "Uncategorized";

                    const auth = await getAuthorizedClient();
                    const sheets = google.sheets({ version: 'v4', auth });
                    const expenseRange = 'Sheet1!A:I';
                    const revenueRange = 'Revenue!A:F';

                    let expenses = [], revenues = [], bills = [];
                    try {
                        const expenseResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: expenseRange });
                        const allRows = expenseResponse.data.values || [];
                        expenses = allRows.slice(1).filter(row => row[5] === "expense");
                        bills = allRows.slice(1).filter(row => row[5] === "bill");

                        const revenueResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: revenueRange });
                        revenues = (revenueResponse.data.values || []).slice(1);
                    } catch (error) {
                        console.error("[ERROR] Failed to fetch data:", error);
                        return res.send(`<Response><Message>⚠️ Could not retrieve your data. Please try again later.</Message></Response>`);
                    }

                    const parseAmount = (amountStr) => parseFloat(amountStr.replace(/[^0-9.-]/g, '')) || 0;
                    const now = new Date();

                    if (input.toLowerCase().includes("profit") && input.toLowerCase().includes("job")) {
                        const jobName = input.match(/job\s+([\w\s]+)/i)?.[1]?.trim() || activeJob;
                        const jobExpenses = expenses.filter(row => row[4] === jobName);
                        const jobRevenues = revenues.filter(row => row[1] === jobName || row[3] === jobName);
                        const totalExpenses = jobExpenses.reduce((sum, row) => sum + parseAmount(row[2]), 0);
                        const totalRevenue = jobRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
                        const profit = totalRevenue - totalExpenses;
                        await setLastQuery(from, { intent: "profit", timestamp: new Date().toISOString() });
                        return res.send(`<Response><Message>Your profit on Job ${jobName} is $${profit.toFixed(2)} (Revenue: $${totalRevenue.toFixed(2)}, Expenses: $${Math.abs(totalExpenses).toFixed(2)}).</Message></Response>`);
                    }

                    try {
                        const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                        const gptResponse = await openaiClient.chat.completions.create({
                            model: "gpt-3.5-turbo",
                            messages: [
                                { role: "system", content: `Interpret financial query: "${input}". Return JSON: { intent: 'profit|spend|revenue|margin|help|unknown', job: 'name or null', period: 'ytd|month|specific month|null', response: 'text' }. If unclear, suggest a correction in 'response'.` },
                                { role: "user", content: input }
                            ],
                            max_tokens: 150,
                            temperature: 0.3
                        });
                        const aiResult = JSON.parse(gptResponse.choices[0].message.content);
                        if (aiResult.intent === "unknown") {
                            const corrections = await correctErrorsWithAI(`Unclear query: "${input}"`);
                            if (corrections && corrections.intent) {
                                return res.send(`<Response><Message>🤔 Did you mean: "${corrections.intent} on ${corrections.job || 'job'} ${corrections.period || ''}"? Reply with corrected query.</Message></Response>`);
                            }
                            return res.send(`<Response><Message>⚠️ I couldn’t understand your request. Try "How much profit on Job 75?"</Message></Response>`);
                        }
                        if (aiResult.intent === "profit" && aiResult.job) {
                            const jobName = aiResult.job;
                            const jobExpenses = expenses.filter(row => row[4] === jobName);
                            const jobRevenues = revenues.filter(row => row[1] === jobName || row[3] === jobName);
                            const totalExpenses = jobExpenses.reduce((sum, row) => sum + parseAmount(row[2]), 0);
                            const totalRevenue = jobRevenues.reduce((sum, row) => sum + parseAmount(row[2]), 0);
                            const profit = totalRevenue - totalExpenses;
                            await setLastQuery(from, { intent: "profit", timestamp: new Date().toISOString() });
                            return res.send(`<Response><Message>${aiResult.response || `Profit for Job ${jobName} is $${profit.toFixed(2)}.`}</Message></Response>`);
                        }
                        return res.send(`<Response><Message>${aiResult.response}</Message></Response>`);
                    } catch (error) {
                        console.error("[ERROR] AI fallback failed:", error.message);
                        return res.send(`<Response><Message>⚠️ I couldn’t process your request...</Message></Response>`);
                    }
                }

                // 12. Media Handling (Expense Logging)
                else if (mediaUrl) {
                    console.log("[DEBUG] Checking media in message...");
                    let combinedText = "";

                    if (mediaType && mediaType.includes("audio")) {
                        const audioResponse = await axios.get(mediaUrl, { responseType: 'arraybuffer', auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN } });
                        const audioBuffer = Buffer.from(audioResponse.data, 'binary');
                        combinedText = await transcribeAudio(audioBuffer) || "";
                    } else if (mediaType && mediaType.includes("image")) {
                        console.log(`[DEBUG] Processing image from ${mediaUrl}`);
                        combinedText = await processDocumentAI(Buffer.from((await axios.get(mediaUrl, { responseType: 'arraybuffer' })).data)) || "";
                    }

                    if (combinedText) {
                        const defaultData = { date: new Date().toISOString().split('T')[0], item: "Unknown", amount: "$0.00", store: "Unknown Store" };
                        const { data, reply, confirmed } = await handleInputWithAI(from, combinedText, 'expense', parseExpenseMessage, defaultData);

                        if (reply) return res.send(`<Response><Message>${reply}</Message></Response>`);
                        if (data && data.item && data.amount && data.amount !== "$0.00" && data.store) {
                            const category = await categorizeEntry('expense', data, ownerProfile);
                            data.suggestedCategory = category;
                            if (confirmed) {
                                await appendToUserSpreadsheet(ownerId, [data.date, data.item, data.amount, data.store, activeJob, 'expense', category, mediaUrl || '', userName]);
                                reply = `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} on ${data.date} by ${userName} (Category: ${category})`;
                                return res.send(`<Response><Message>${reply}</Message></Response>`);
                            } else {
                                await setPendingTransactionState(from, { pendingExpense: data });
                                const sent = await sendTemplateMessage(from, confirmationTemplates.expense, {
                                    "1": `Expense of ${data.amount} for ${data.item} from ${data.store} on ${data.date} (Category: ${category})`
                                });
                                return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>⚠️ Failed to send confirmation.</Message></Response>`);
                            }
                        }
                        return res.send(`<Response><Message>🤔 Couldn’t parse a valid expense from the media. Please try again.</Message></Response>`);
                    } else {
                        return res.send(`<Response><Message>⚠️ No media detected or unable to extract information.</Message></Response>`);
                    }
                }

                // 13. Quote Handling (Owner Only) (Updated with #5)
                else if (input.toLowerCase().startsWith("quote")) {
                    if (!isOwner) {
                        return res.send(`<Response><Message>⚠️ Only the owner can generate quotes.</Message></Response>`);
                    }
                    console.log('[DEBUG] Detected quote request:', input);

                    // Handle pending quote confirmation (customer name/email)
                    if (pendingState && pendingState.pendingQuote) {
                        const { jobName, items, total, isFixedPrice, description } = pendingState.pendingQuote;
                        const customerInput = input.trim();
                        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                        const customerName = emailRegex.test(customerInput) ? 'Email Provided' : customerInput;
                        const customerEmail = emailRegex.test(customerInput) ? customerInput : null;

                        const taxRate = getTaxRate(userProfileData.country, userProfileData.province); // #5
                        const subtotal = total;
                        const tax = subtotal * taxRate;
                        const totalWithTax = isFixedPrice ? subtotal + tax : subtotal + tax;
                        const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD'; // #5

                        const outputPath = `/tmp/quote_${from}_${Date.now()}.pdf`;
                        const quoteData = {
                            jobName,
                            items: isFixedPrice ? [{ item: description, quantity: 1, price: subtotal }] : items,
                            subtotal,
                            tax,
                            total: totalWithTax,
                            customerName,
                            contractorName: ownerProfile.name || 'Your Company Name',
                            companyName: ownerProfile.companyName,
                            companyAddress: ownerProfile.companyAddress,
                            companyPhone: ownerProfile.companyPhone,
                            logoUrl: ownerProfile.logoUrl
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

                        reply = `✅ Quote for ${jobName} generated.\nSubtotal: ${currency} ${subtotal.toFixed(2)}\nTax (${(taxRate * 100).toFixed(2)}%): ${currency} ${tax.toFixed(2)}\nTotal: ${currency} ${totalWithTax.toFixed(2)}\nCustomer: ${customerName}\nDownload here: ${pdfUrl}`; // #5 Updated
                        if (customerEmail) {
                            await sendSpreadsheetEmail(customerEmail, driveResponse.data.id, 'Your Quote');
                            reply += `\nAlso sent to ${customerEmail}`;
                        }
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }

                    // Fixed-price quote (e.g., "quote for Job 75: 100 for painting")
                    const fixedPriceMatch = input.match(/quote for\s+([^:]+):\s*(\d+(?:\.\d{1,2})?)\s+for\s+(.+)/i);
                    if (fixedPriceMatch) {
                        const jobName = fixedPriceMatch[1].trim();
                        const subtotal = parseFloat(fixedPriceMatch[2]);
                        const description = fixedPriceMatch[3].trim();
                        const data = { jobName, amount: `$${subtotal}`, date: new Date().toISOString().split('T')[0] };
                        const errors = detectErrors(data, 'quote');
                        if (errors) {
                            const corrections = await correctErrorsWithAI(errors);
                            if (corrections) {
                                return res.send(`<Response><Message>🤔 Issues with quote:\n${Object.entries(corrections).map(([k, v]) => `${k}: ${v}`).join('\n')}\nPlease correct and resend.</Message></Response>`);
                            }
                        }
                        const taxRate = getTaxRate(userProfileData.country, userProfileData.province); // #5
                        const tax = subtotal * taxRate;
                        const totalWithTax = subtotal * (1 + taxRate); // #5
                        const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD'; // #5
                        await setPendingTransactionState(from, { pendingQuote: { jobName, items: [], total: subtotal, isFixedPrice: true, description } });
                        reply = `✅ Quote calculated: ${currency} ${subtotal.toFixed(2)} (subtotal).\nTotal with tax (${(taxRate * 100).toFixed(2)}%): ${currency} ${totalWithTax.toFixed(2)}\nPlease provide customer’s name or email.`; // #5 Updated
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                    

                    // Itemized quote using parseQuoteMessage and buildQuoteDetails
                    const parsedQuote = parseQuoteMessage(input);
                    if (!parsedQuote) {
                        return res.send(`<Response><Message>⚠️ Please provide a job name and items, e.g., 'Quote for Job 75: 10 nails, $50 for paint'</Message></Response>`);
                    }

                    const { jobName, items } = parsedQuote;
                    if (!items.length) {
                        return res.send(`<Response><Message>⚠️ Please list items or a total, e.g., '10 nails plus 40%'</Message></Response>`);
                    }

                    const quoteDetails = await buildQuoteDetails(parsedQuote, ownerProfile);
                    const data = { jobName, amount: `$${quoteDetails.total}`, date: new Date().toISOString().split('T')[0] };
                    const errors = detectErrors(data, 'quote');
                    if (errors) {
                        const corrections = await correctErrorsWithAI(errors);
                        if (corrections) {
                            return res.send(`<Response><Message>🤔 Issues with quote:\n${Object.entries(corrections).map(([k, v]) => `${k}: ${v}`).join('\n')}\nPlease correct and resend.</Message></Response>`);
                        }
                    }

                    const taxRate = getTaxRate(userProfileData.country, userProfileData.province); // #5
                    const subtotal = quoteDetails.total;
                    const totalWithTax = subtotal * (1 + taxRate); // #5
                    const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD'; // #5
                    await setPendingTransactionState(from, { pendingQuote: { jobName, ...quoteDetails, isFixedPrice: false } });
                    reply = `✅ Quote calculated: ${currency} ${subtotal.toFixed(2)} (subtotal).\nTotal with tax (${(taxRate * 100).toFixed(2)}%): ${currency} ${totalWithTax.toFixed(2)}`; // #5 Updated
                    if (quoteDetails.missingItems.length) {
                        reply += `\n⚠️ Missing prices for: ${quoteDetails.missingItems.join(', ')}.`;
                    }
                    reply += `\nPlease provide customer’s name or email.`;
                    return res.send(`<Response><Message>${reply}</Message></Response>`);
                }
                
              // 14. Text Expense Logging (~1680-1700)
              else if (input) {
                console.log("[DEBUG] Attempting to parse message:", input);
                const activeJob = await getActiveJob(ownerId) || "Uncategorized";
                const parseFn = type === 'expense' ? parseExpenseMessage : parseRevenueMessage;
                const defaultData = type === 'expense'
                    ? { date: new Date().toISOString().split('T')[0], item: "Unknown", amount: "$0.00", store: "Unknown Store" }
                    : { date: new Date().toISOString().split('T')[0], description: "Payment", amount: "$0.00", client: "Unknown Client" };

                try {
                    const { data, reply, confirmed } = await handleInputWithAI(from, input, type, parseFn, defaultData);

                    if (reply) return res.send(`<Response><Message>${reply}</Message></Response>`);
                    if (data && data.amount && data.amount !== "$0.00") {
                        const category = await categorizeEntry(type, data, ownerProfile);
                        data.suggestedCategory = category;
                        if (confirmed) {
                            await appendToUserSpreadsheet(ownerId, type === 'expense'
                                ? [data.date, data.item, data.amount, data.store, activeJob, 'expense', category, mediaUrl || '', userName]
                                : [data.date, data.description, data.amount, data.client, activeJob, 'revenue', category, '', userName]
                            );
                            return res.send(`<Response><Message>✅ ${type} logged: ${data.amount} ${type === 'expense' ? `for ${data.item} from ${data.store}` : `from ${data.client}`} on ${data.date} by ${userName} (Category: ${category}).</Message></Response>`);
                        } else {
                            await setPendingTransactionState(from, { [type === 'expense' ? 'pendingExpense' : 'pendingRevenue']: data });
                            const template = type === 'expense' ? confirmationTemplates.expense : confirmationTemplates.revenue;
                            const sent = await sendTemplateMessage(from, template, {
                                "1": `${type === 'expense' ? `Expense of ${data.amount} for ${data.item} from ${data.store}` : `Revenue of ${data.amount} from ${data.client}`} on ${data.date} (Category: ${category})`
                            });
                            return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>⚠️ Failed to send confirmation. Try again.</Message></Response>`);
                        }
                    }

                    // 15. Tax Rate Command (~1701) (#3)
                    else if (input.toLowerCase().includes("tax rate")) {
                        const taxRate = getTaxRate(userProfileData.country, userProfileData.province);
                        const reply = `Your tax rate is ${(taxRate * 100).toFixed(2)}%${taxRate === 0 ? ' (No sales tax)' : ''}.`;
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }

                    // 16. Tax Export Command (~1701) (#3)
                    else if (input.toLowerCase().startsWith("export tax")) {
                        const sheets = google.sheets({ version: 'v4', auth: await getAuthorizedClient() });
                        const spreadsheetId = await getUserSpreadsheetId(ownerId);
                        const expenses = await fetchExpenseData(ownerId);
                        const revenues = (await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Revenue!A:I' })).data.values.slice(1);
                        const taxRate = getTaxRate(userProfileData.country, userProfileData.province);
                        const currency = userProfileData.country === 'United States' ? 'USD' : 'CAD';
                        const revenueData = revenues.map(r => {
                            const amount = parseFloat(r[2].replace(/[^0-9.]/g, ''));
                            return [r[0], r[1], `${currency} ${amount.toFixed(2)}`, `Revenue (Tax: ${currency} ${(amount * taxRate).toFixed(2)})`, r[8]];
                        });
                        const expenseDataPromises = expenses.filter(e => e[5] === 'expense' || e[5] === 'bill').map(async e => [
                            e[0], e[1], e[2], await suggestDeductions(ownerId, { description: e[1], category: e[6] }), e[8]
                        ]);
                        const expenseData = await Promise.all(expenseDataPromises);
                        const taxData = [...revenueData, ...expenseData];
                        await sheets.spreadsheets.values.update({
                            spreadsheetId,
                            range: 'TaxExport!A:E',
                            valueInputOption: 'RAW',
                            resource: { values: [['Date', 'Item', 'Amount', 'Category', 'Logged By'], ...taxData] }
                        });
                        const totalTaxCollected = revenues.reduce((sum, r) => sum + parseFloat(r[2].replace(/[^0-9.]/g, '')) * taxRate, 0);
                        reply = `✅ Tax export ready in 'TaxExport'. ${taxData.length} entries, ${currency} ${totalTaxCollected.toFixed(2)} tax collected.`;
                        return res.send(`<Response><Message>${reply}</Message></Response>`);
                    }
                    // Final fallback (~1705)
                    else {
                        return res.send(`<Response><Message>⚠️ Command not recognized. Try "help" for options.</Message></Response>`);
                    }
                } catch (error) {
                    console.error("[ERROR] Text expense logging failed:", error.message);
                    return res.send(`<Response><Message>⚠️ Failed to process your input. Try again.</Message></Response>`);
                }
            }
        }
        } catch (innerError) {
            console.error("[ERROR] Inner webhook processing failed:", innerError.message);
            return res.send(`<Response><Message>⚠️ Processing failed. Try again.</Message></Response>`);
        }
    } catch (error) {
        console.error("[ERROR] Webhook processing failed:", error.message);
        return res.status(500).send(`<Response><Message>⚠️ Server error. Try again later.</Message></Response>`);
    }
});
// PWA Parse Endpoint
app.post('/parse', async (req, res) => {
    const { input, type = 'expense' } = req.body;
    if (!input) return res.status(400).json({ error: "Missing input" });

    const parseFn = type === 'expense' ? parseExpenseMessage : parseRevenueMessage;
    const defaultData = type === 'expense'
        ? { date: new Date().toISOString().split('T')[0], item: "Unknown", amount: "$0.00", store: "Unknown Store" }
        : { date: new Date().toISOString().split('T')[0], description: "Payment", amount: "$0.00", client: "Unknown Client" };

    try {
        const { data, reply, confirmed } = await handleInputWithAI('pwa-user', input, type, parseFn, defaultData);
        res.json({ data, reply, confirmed });
    } catch (error) {
        console.error("[ERROR] Parse endpoint failed:", error.message);
        res.status(500).json({ error: "Parsing failed" });
    }
});
// Deep Dive Endpoint
const DEEP_DIVE_TIERS = {
    BASIC: { price: 49, name: "Basic Report", features: ["historical"] },
    FULL: { price: 99, name: "Full Deep Dive", features: ["historical", "forecast_1yr"] },
    ENTERPRISE: { price: 199, name: "Enterprise Custom", features: ["historical", "forecast_10yr", "goals"] }
};

app.post('/deep-dive', async (req, res) => {
    const { userId, tier = 'BASIC', file } = req.body; // Assume file is base64-encoded
    if (!userId || !DEEP_DIVE_TIERS[tier]) {
        return res.status(400).json({ error: "Invalid userId or tier" });
    }

    try {
        let financialData = [];
        const userProfile = await getUserProfile(userId);
        const ownerId = userProfile.ownerId || userId;

        // Pull WhatsApp data if subscribed
        if (userProfile.spreadsheetId) {
            const auth = await getAuthorizedClient();
            const sheets = google.sheets({ version: 'v4', auth });
            const [expenseResponse, revenueResponse] = await Promise.all([
                sheets.spreadsheets.values.get({ spreadsheetId: userProfile.spreadsheetId, range: 'Sheet1!A:I' }),
                sheets.spreadsheets.values.get({ spreadsheetId: userProfile.spreadsheetId, range: 'Revenue!A:I' })
            ]);
            financialData = [
                ...(expenseResponse.data.values || []).slice(1).map(row => ({
                    date: row[0], amount: row[2].replace('$', ''), description: row[1], source: row[3], type: row[5]
                })),
                ...(revenueResponse.data.values || []).slice(1).map(row => ({
                    date: row[0], amount: row[2].replace('$', ''), description: row[1], source: row[3], type: row[5]
                }))
            ];
        }

        // Process uploaded file
        if (file) {
            const fileBuffer = Buffer.from(file, 'base64');
            const fileType = req.headers['content-type'] || 'text/csv';
            const uploadedData = parseFinancialFile(fileBuffer, fileType);
            financialData = financialData.length ? [...financialData, ...uploadedData] : uploadedData;
        }

        if (!financialData.length) {
            return res.status(400).json({ error: "No financial data provided" });
        }

        // Categorize entries
        for (let entry of financialData) {
            entry.category = await categorizeEntry(entry.type, entry, userProfile);
        }

        // Generate report
        const pdfUrl = await generateDeepDiveReport(userId, financialData, DEEP_DIVE_TIERS[tier]);

        // Trigger 30-day trial if not subscribed
        if (!userProfile.subscriptionTier) {
            await db.collection('users').doc(userId).update({
                subscriptionTier: 'Pro',
                trialStart: new Date().toISOString(),
                trialEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                tokenUsage: { messages: 0, aiCalls: 0 }
            });
            await updateUserTokenUsage(userId, { messages: 1, aiCalls: 1 }); // For report generation
            await sendTemplateMessage(userId, "HXwelcome_trial", [
                { type: "text", text: userProfile.name || "User" },
                { type: "text", text: "30-day trial activated! Start logging expenses via WhatsApp." }
            ]);
        } else {
            await updateUserTokenUsage(userId, { messages: 1, aiCalls: 1 }); // Track report generation
        }

        res.json({ reportUrl: pdfUrl, message: "Deep Dive report generated successfully" });
    } catch (error) {
        console.error("[ERROR] Deep Dive processing failed:", error.message);
        res.status(500).json({ error: "Failed to generate report" });
    }
});
// ─── Helper Functions for Bill Management ─────────────────────────────


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