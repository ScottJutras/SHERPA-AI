// ─── IMPORTS ────────────────────────────────────────────────────────────────
const { google } = require('googleapis');
const admin = require('firebase-admin');

// ─── FIREBASE ADMIN / FIRESTORE SETUP ─────────────────────────────────────────
// Initialize Firebase Admin if not already initialized.
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
    console.log("[DEBUG] Firebase Admin initialized successfully.");
  } catch (error) {
    console.error("[ERROR] Failed to initialize Firebase Admin:", error.message);
    process.exit(1);
  }
}
const db = admin.firestore();

// ─── GOOGLE CREDENTIALS & AUTH SETUP ───────────────────────────────────────────
if (!process.env.GOOGLE_CREDENTIALS_BASE64) {
  throw new Error("[ERROR] GOOGLE_CREDENTIALS_BASE64 is missing. Cannot authenticate Google Sheets API.");
}
const googleCredentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
);

// Scopes required for Sheets and Drive.
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file'
];

/**
 * Initialize and return an authorized Google API client.
 */
async function getAuthorizedClient() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: googleCredentials,
      scopes: SCOPES,
    });
    console.log('[DEBUG] Google API client authorized successfully.');
    return auth;
  } catch (error) {
    console.error('[ERROR] Failed to authorize Google API client:', error.message);
    throw error;
  }
}

// ─── SPREADSHEET CREATION & RETRIEVAL ─────────────────────────────────────────
/**
 * Creates a new spreadsheet for a user using the Google Sheets API.
 * The spreadsheet is created with one sheet ("Sheet1") that includes header values.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @returns {Promise<string>} The spreadsheet ID.
 */
async function createSpreadsheetForUser(phoneNumber) {
  try {
    console.log(`[DEBUG] Creating a new spreadsheet for user: ${phoneNumber}`);
    const auth = await getAuthorizedClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.create({
      resource: {
        properties: { title: `Expenses - ${phoneNumber}` },
        sheets: [
          {
            properties: { title: 'Sheet1' },
            data: {
              rowData: [
                {
                  values: [
                    { userEnteredValue: { stringValue: 'Date' } },
                    { userEnteredValue: { stringValue: 'Item' } },
                    { userEnteredValue: { stringValue: 'Amount' } },
                    { userEnteredValue: { stringValue: 'Store' } },
                    { userEnteredValue: { stringValue: 'Job' } }
                  ]
                }
              ]
            }
          }
        ]
      },
      fields: 'spreadsheetId',
    });
    console.log(`[✅ SUCCESS] Spreadsheet created: ${response.data.spreadsheetId}`);
    return response.data.spreadsheetId;
  } catch (error) {
    console.error(`[❌ ERROR] Failed to create spreadsheet for ${phoneNumber}:`, error.message);
    throw error;
  }
}

/**
 * Retrieves (from Firestore) or creates a new spreadsheet for a user.
 * Each user gets their own spreadsheet.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @returns {Promise<string>} The spreadsheet ID.
 */
async function getOrCreateUserSpreadsheet(phoneNumber) {
  try {
    const userDoc = db.collection('users').doc(phoneNumber);
    const userSnapshot = await userDoc.get();
    let spreadsheetId;
    if (userSnapshot.exists && userSnapshot.data().spreadsheetId) {
      spreadsheetId = userSnapshot.data().spreadsheetId;
    } else {
      console.log(`[DEBUG] No spreadsheet found for user (${phoneNumber}). Creating a new one.`);
      spreadsheetId = await createSpreadsheetForUser(phoneNumber);
      await userDoc.set({ spreadsheetId }, { merge: true });
      console.log(`[✅ SUCCESS] Spreadsheet created and saved to Firebase for user (${phoneNumber}): ${spreadsheetId}`);
    }
    return spreadsheetId;
  } catch (error) {
    console.error(`[❌ ERROR] Failed to retrieve or create spreadsheet for user (${phoneNumber}):`, error.message);
    throw error;
  }
}

/**
 * Append an expense entry to the user's spreadsheet.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @param {Array} rowData - An array: [Date, Item, Amount, Store, Job]
 */
async function appendToUserSpreadsheet(phoneNumber, rowData) {
  try {
    const spreadsheetId = await getOrCreateUserSpreadsheet(phoneNumber);
    console.log(`[DEBUG] Using Spreadsheet ID: ${spreadsheetId}`);
    const auth = await getAuthorizedClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const RANGE = 'Sheet1!A:E'; // Columns: Date, Item, Amount, Store, Job
    const resource = { values: [rowData] };

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: RANGE,
      valueInputOption: 'USER_ENTERED',
      resource,
    });

    console.log(`[✅ SUCCESS] Data successfully appended: ${JSON.stringify(rowData)}`);
  } catch (error) {
    console.error('[❌ ERROR] Failed to append data to spreadsheet:', error.message);
    throw error;
  }
}

/**
 * Fetch expense data from the user's spreadsheet, filtered by job name.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @param {string} jobName - The job name to filter expenses.
 * @returns {Promise<Array>} An array of expense objects.
 */
async function fetchExpenseData(phoneNumber, jobName) {
  try {
    const spreadsheetId = await getOrCreateUserSpreadsheet(phoneNumber);
    const auth = await getAuthorizedClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const RANGE = 'Sheet1!A:E'; // Columns: Date, Item, Amount, Store, Job
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: RANGE,
    });

    const rows = response.data.values;
    if (!rows || rows.length <= 1) {
      console.log('[DEBUG] No expense data found.');
      return [];
    }

    return rows.slice(1)
      .filter(row => row[4] === jobName)
      .map(row => ({
        date: row[0],
        item: row[1],
        amount: parseFloat(row[2].replace('$', '')) || 0,
        store: row[3],
        job: row[4],
      }));
  } catch (error) {
    console.error('[ERROR] Failed to fetch expense data:', error.message);
    throw error;
  }
}

// ─── ACTIVE JOB HANDLING (Using Firestore) ───────────────────────────────────
/**
 * Set the active job for a user in Firestore.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @param {string} jobName - The job to set as active.
 */
async function setActiveJob(phoneNumber, jobName) {
  try {
    await db.collection('users').doc(phoneNumber).set({ activeJob: jobName }, { merge: true });
    console.log(`[✅ SUCCESS] Active job set for ${phoneNumber}: ${jobName}`);
  } catch (error) {
    console.error('[❌ ERROR] Failed to set active job:', error.message);
    throw error;
  }
}

/**
 * Get the active job for a user from Firestore.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @returns {Promise<string|null>} The active job name, or null if not set.
 */
async function getActiveJob(phoneNumber) {
  try {
    const userDoc = await db.collection('users').doc(phoneNumber).get();
    return userDoc.exists ? userDoc.data().activeJob : null;
  } catch (error) {
    console.error('[❌ ERROR] Failed to retrieve active job:', error.message);
    throw error;
  }
}

// ─── EXPENSE ANALYTICS ─────────────────────────────────────────────────────────
/**
 * Calculate expense analytics (total spent, top store, etc.) from expense data.
 *
 * @param {Array} expenseData
 * @returns {Object|null} Analytics results or null if no data.
 */
function calculateExpenseAnalytics(expenseData) {
  if (!expenseData || expenseData.length === 0) {
    return null;
  }

  let totalSpent = 0;
  let storeCount = {};
  let itemCount = {};
  let biggestPurchase = { item: null, amount: 0 };

  for (const expense of expenseData) {
    totalSpent += expense.amount;
    storeCount[expense.store] = (storeCount[expense.store] || 0) + 1;
    itemCount[expense.item] = (itemCount[expense.item] || 0) + 1;
    if (expense.amount > biggestPurchase.amount) {
      biggestPurchase = { item: expense.item, amount: expense.amount };
    }
  }

  let topStore = Object.keys(storeCount).reduce((a, b) => (storeCount[a] > storeCount[b] ? a : b));
  let mostFrequentItem = Object.keys(itemCount).reduce((a, b) => (itemCount[a] > itemCount[b] ? a : b));

  return {
    totalSpent: `$${totalSpent.toFixed(2)}`,
    topStore,
    biggestPurchase: `${biggestPurchase.item} for $${biggestPurchase.amount.toFixed(2)}`,
    mostFrequentItem,
  };
}

// ─── RECEIPT PARSING & LOGGING ───────────────────────────────────────────────
/**
 * Parses raw OCR text from a receipt.
 *
 * @param {string} text - Raw OCR text.
 * @returns {Object|null} Parsed data containing date, item, amount, and store.
 */
function parseReceiptText(text) {
  try {
    console.log("[DEBUG] Raw OCR Text:", text);
    // Remove extra spaces and split into lines.
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    // 1. Store Name: take the first line that looks like a store name.
    let store = lines.find(line => /^[A-Za-z0-9\s&-]+$/.test(line) &&
      !/survey|contest|gift|rules|terms|conditions|receipt|transaction/i.test(line));
    if (!store) {
      store = lines[0] || "Unknown Store";
    }

    // 2. Date Extraction: look for common date formats.
    let dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4}|\d{2}\/\d{2}\/\d{2}|\d{4}-\d{2}-\d{2})/);
    let date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

    // 3. Amount Extraction: try to find a line containing "total" first.
    let amount;
    for (let i = 0; i < lines.length; i++) {
      if (/total/i.test(lines[i])) {
        const amtMatch = lines[i].match(/\$?(\d{1,6}\.\d{2})/);
        if (amtMatch) {
          amount = `$${amtMatch[1]}`;
          break;
        }
      }
    }
    if (!amount) {
      const amountMatches = text.match(/\$?(\d{1,6}\.\d{2})/gi);
      if (amountMatches) {
        amount = `$${amountMatches[amountMatches.length - 1].replace('$', '')}`;
      } else {
        amount = "Unknown Amount";
      }
    }

    // 4. Item Extraction: take a line that appears to be an item description.
    let item = lines.find(line => /\d+\s*(L|EA|KG|X|x|@|\$)/.test(line));
    if (!item) {
      item = lines.find(line => /[a-zA-Z]{3,}/.test(line) &&
        !/store|total|receipt|cash|change|approval|tax/i.test(line)) || "Miscellaneous Purchase";
    }

    console.log(`[DEBUG] Parsed - Store: ${store}, Date: ${date}, Item: ${item}, Amount: ${amount}`);
    return { date, item, amount, store };
  } catch (error) {
    console.error("[ERROR] Parsing failed:", error.message);
    return null;
  }
}

/**
 * Logs a receipt expense by parsing the OCR text and appending the data to the user's spreadsheet.
 *
 * @param {string} phoneNumber - The user's phone number.
 * @param {string} extractedText - The OCR-extracted text from the receipt.
 */
async function logReceiptExpense(phoneNumber, extractedText) {
  console.log("[DEBUG] Logging receipt expense...");

  const parsedData = parseReceiptText(extractedText);
  if (!parsedData) {
    console.error("[ERROR] Failed to parse OCR data:", extractedText);
    return;
  }
  console.log(`[DEBUG] Parsed Data: ${JSON.stringify(parsedData)}`);

  // Check for missing required fields.
  let missingFields = [];
  if (!parsedData.date) missingFields.push("Date");
  if (!parsedData.amount || parsedData.amount === "Unknown Amount") missingFields.push("Amount");
  if (!parsedData.store || parsedData.store === "Unknown Store") missingFields.push("Store");

  if (missingFields.length > 0) {
    console.error(`[ERROR] Missing required fields: ${missingFields.join(", ")}`, parsedData);
    return;
  }

  // Get the active job from Firestore.
  const activeJob = await getActiveJob(phoneNumber) || "No Active Job";

  console.log("[DEBUG] Attempting to log to Google Sheets...");
  return appendToUserSpreadsheet(phoneNumber, [
    parsedData.date,
    parsedData.item || "Miscellaneous",
    parsedData.amount,
    parsedData.store,
    activeJob,
  ]);
}

// ─── MODULE EXPORTS ───────────────────────────────────────────────────────────
module.exports = {
  appendToUserSpreadsheet,
  fetchExpenseData,
  logReceiptExpense,
  getOrCreateUserSpreadsheet,
  setActiveJob,
  getActiveJob,
  createSpreadsheetForUser,
  calculateExpenseAnalytics,
  parseReceiptText,
};
