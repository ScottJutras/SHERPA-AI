const { google } = require('googleapis');
const admin = require('firebase-admin');

// ✅ Load Google Credentials from Base64
let googleCredentials;
if (process.env.GOOGLE_CREDENTIALS_BASE64) {
    try {
        googleCredentials = JSON.parse(
            Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
        );
        console.log("[DEBUG] Successfully loaded Google Credentials from Base64.");
    } catch (error) {
        console.error("[ERROR] Failed to decode GOOGLE_CREDENTIALS_BASE64:", error.message);
        process.exit(1);
    }
} else {
    console.error("[ERROR] GOOGLE_CREDENTIALS_BASE64 is not set in environment variables.");
    process.exit(1);
}

// ✅ Initialize Firebase Admin SDK
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

// ✅ Google API Scopes
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'];

// ✅ Function to initialize Google API client
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

// ✅ Function to create a new Google Spreadsheet for a user
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
            }
        });

        console.log(`[✅ SUCCESS] Spreadsheet created: ${response.data.spreadsheetId}`);
        return response.data.spreadsheetId;
    } catch (error) {
        console.error(`[❌ ERROR] Failed to create spreadsheet for ${phoneNumber}:`, error.message);
        throw error;
    }
}

// ✅ Function to retrieve or create a spreadsheet for a user
async function getOrCreateUserSpreadsheet(phoneNumber) {
    try {
        const userDoc = db.collection('users').doc(phoneNumber);
        const userSnapshot = await userDoc.get();

        if (userSnapshot.exists && userSnapshot.data().spreadsheetId) {
            return userSnapshot.data().spreadsheetId;
        }

        console.log(`[DEBUG] No spreadsheet found for user (${phoneNumber}). Creating a new one.`);
        const spreadsheetId = await createSpreadsheetForUser(phoneNumber);

        await userDoc.set({ spreadsheetId }, { merge: true });
        console.log(`[✅ SUCCESS] Spreadsheet created and saved to Firebase for user (${phoneNumber}): ${spreadsheetId}`);

        return spreadsheetId;
    } catch (error) {
        console.error(`[❌ ERROR] Failed to retrieve or create spreadsheet for user (${phoneNumber}):`, error.message);
        throw error;
    }
}

// ✅ Function to append data to a user's spreadsheet
async function appendToUserSpreadsheet(phoneNumber, data) {
    try {
        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });

        console.log(`[DEBUG] Retrieving spreadsheet for ${phoneNumber}`);
        const spreadsheetId = await getOrCreateUserSpreadsheet(phoneNumber);
        console.log(`[DEBUG] Using Spreadsheet ID: ${spreadsheetId}`);

        const RANGE = 'Sheet1!A:E'; // Columns: Date, Item, Amount, Store, Job

        const resource = {
            values: [data], // Append data
        };

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: RANGE,
            valueInputOption: 'USER_ENTERED',
            resource,
        });

        console.log(`[✅ SUCCESS] Data successfully appended to spreadsheet (${spreadsheetId}): ${JSON.stringify(data)}`);
    } catch (error) {
        console.error('[❌ ERROR] Failed to append data to spreadsheet:', error.message);
        throw error;
    }
}

// ✅ Function to fetch expenses filtered by job
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
                job: row[4]
            }));
    } catch (error) {
        console.error('[ERROR] Failed to fetch expense data:', error.message);
        throw error;
    }
}

// ✅ Function to set the active job for a user (RESTORED)
async function setActiveJob(phoneNumber, jobName) {
    try {
        await db.collection('users').doc(phoneNumber).set({ activeJob: jobName }, { merge: true });
        console.log(`[✅ SUCCESS] Active job set for ${phoneNumber}: ${jobName}`);
    } catch (error) {
        console.error('[❌ ERROR] Failed to set active job:', error.message);
        throw error;
    }
}

// ✅ Function to get the active job for a user (RESTORED)
async function getActiveJob(phoneNumber) {
    try {
        const userDoc = await db.collection('users').doc(phoneNumber).get();
        return userDoc.exists ? userDoc.data().activeJob : null;
    } catch (error) {
        console.error('[❌ ERROR] Failed to retrieve active job:', error.message);
        throw error;
    }
}
// ✅ Function to calculate expense analytics
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

        // Track store frequency
        if (storeCount[expense.store]) {
            storeCount[expense.store]++;
        } else {
            storeCount[expense.store] = 1;
        }

        // Track item frequency
        if (itemCount[expense.item]) {
            itemCount[expense.item]++;
        } else {
            itemCount[expense.item] = 1;
        }

        // Find the biggest purchase
        if (expense.amount > biggestPurchase.amount) {
            biggestPurchase = { item: expense.item, amount: expense.amount };
        }
    }

    // Find most frequent store & item
    let topStore = Object.keys(storeCount).reduce((a, b) => (storeCount[a] > storeCount[b] ? a : b));
    let mostFrequentItem = Object.keys(itemCount).reduce((a, b) => (itemCount[a] > itemCount[b] ? a : b));

    return {
        totalSpent: `$${totalSpent.toFixed(2)}`,
        topStore,
        biggestPurchase: `${biggestPurchase.item} for $${biggestPurchase.amount.toFixed(2)}`,
        mostFrequentItem
    };
}
// Improved parseReceiptText function
function parseReceiptText(text) {
    try {
      console.log("[DEBUG] Raw OCR Text:", text);
  
      // Split into lines, trim, and drop empty lines
      const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
      // Remove lines that are likely to be marketing or survey fluff
      const filteredLines = lines.filter(line =>
        !/(survey|contest|win|gift|rules|terms|conditions|receipt|card|cash|change|approval)/i.test(line)
      );
  
      // 1. Extract Store Name  
      // Use the first meaningful line from the filtered set.
      // (Allow numbers too – many stores include a number.)
      let store = filteredLines[0] || "Unknown Store";
      // Optionally, if the store name looks “off,” fall back to the very first line.
      if (!/^[A-Za-z0-9\s&-]+$/.test(store)) {
        store = lines[0] || "Unknown Store";
      }
  
      // 2. Extract Date  
      // Try first for MM/DD/YYYY, then MM/DD/YY.
      let dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4})/);
      if (!dateMatch) {
        dateMatch = text.match(/(\d{2}\/\d{2}\/\d{2})/);
      }
      // If nothing is found, default to today’s date.
      let date = dateMatch ? dateMatch[0] : new Date().toISOString().split('T')[0];
  
      // 3. Extract Amount  
      // First, look for a line containing the word "total"
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
      // Fallback: get the last matched amount in the entire text.
      if (!amount) {
        const amountMatches = text.match(/\$?(\d{1,6}\.\d{2})/gi);
        if (amountMatches && amountMatches.length > 0) {
          // Ensure we have a consistent format (strip any duplicate '$')
          amount = `$${amountMatches[amountMatches.length - 1].replace('$','')}`;
        } else {
          amount = "Unknown Amount";
        }
      }
  
      // 4. Extract Item Description  
      // As receipts vary a lot, you can choose to take the second meaningful line,
      // or just use a default description.
      let item = filteredLines[1] || "Miscellaneous";
  
      console.log(`[DEBUG] Parsed Receipt - Store: ${store}, Date: ${date}, Item: ${item}, Amount: ${amount}`);
      return { date, item, amount, store };
    } catch (error) {
      console.error("[ERROR] Failed to parse receipt text:", error.message);
      return null;
    }
  }
  
  // Improved logReceiptExpense function (includes active job)
  async function logReceiptExpense(phoneNumber, extractedText) {
    console.log("[DEBUG] Logging receipt expense...");
  
    const parsedData = parseReceiptText(extractedText);
    if (!parsedData) {
      console.error("[ERROR] Failed to parse OCR data:", extractedText);
      return;
    }
    console.log(`[DEBUG] Parsed Data: ${JSON.stringify(parsedData)}`);
  
    // Check for missing required fields
    let missingFields = [];
    if (!parsedData.date) missingFields.push("Date");
    if (!parsedData.amount || parsedData.amount === "Unknown Amount") missingFields.push("Amount");
    if (!parsedData.store || parsedData.store === "Unknown Store") missingFields.push("Store");
  
    if (missingFields.length > 0) {
      console.error(`[ERROR] Missing required fields: ${missingFields.join(", ")}`, parsedData);
      return;
    }
  
    // IMPORTANT: Include the active job so the expense is logged correctly.
    // (Assumes getActiveJob is defined/imported as in your original code.)
    const activeJob = await getActiveJob(phoneNumber) || "No Active Job";
  
    console.log("[DEBUG] Attempting to log to Google Sheets...");
    return appendToUserSpreadsheet(phoneNumber, [
      parsedData.date,
      parsedData.item || "Miscellaneous",
      parsedData.amount,
      parsedData.store,
      activeJob
    ]);
  }  
// ✅ Exporting all required functions
module.exports = {
    appendToUserSpreadsheet,
    fetchExpenseData,
    logReceiptExpense,
    getOrCreateUserSpreadsheet,
    setActiveJob,
    getActiveJob,
    createSpreadsheetForUser,
    calculateExpenseAnalytics,
};


