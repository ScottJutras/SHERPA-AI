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
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'];

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

// ✅ Function to parse receipt text from OCR
function parseReceiptText(text) {
    try {
        console.log("[DEBUG] Raw OCR Text:", text);
        const lines = text.split('\n').map(line => line.trim());

        // Extract Store Name (First line usually)
        let store = lines[0] || "Unknown Store";

        // Extract Date (Formats: MM/DD/YY or YYYY-MM-DD)
        let dateMatch = text.match(/(\d{2}\/\d{2}\/\d{2,4})/);
        let date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

        // Extract Total Amount (Find the last occurrence of a price)
        let amountMatch = text.match(/\$([\d,]+(?:\.\d{1,2})?)/g);
        let amount = amountMatch ? `$${amountMatch[amountMatch.length - 1]}` : "Unknown Amount";

        // Extract Items (Lines before "TOTAL" or "SUB TOTAL")
        let items = [];
        for (let i = 0; i < lines.length; i++) {
            if (/total/i.test(lines[i]) || /sub total/i.test(lines[i])) break; // Stop at "TOTAL"
            if (/\d+ EA @/.test(lines[i]) || /\d+\.\d{2}/.test(lines[i])) {
                items.push(lines[i].replace(/\d+ EA @/, "").trim()); // Remove "2 EA @" quantity part
            }
        }

        return {
            date,
            item: items.join(", ") || "Unknown Items",
            amount,
            store
        };
    } catch (error) {
        console.error("[ERROR] Failed to parse receipt text:", error.message);
        return null;
    }
}

// ✅ Function to log receipt-based expenses
async function logReceiptExpense(phoneNumber, extractedText) {
    const parsedData = parseReceiptText(extractedText);
    if (!parsedData) {
        console.error("[ERROR] Failed to parse OCR data.");
        return;
    }
    return appendToUserSpreadsheet(phoneNumber, [
        parsedData.date,
        parsedData.item,
        parsedData.amount,
        parsedData.store
    ]);
}

// ✅ Exporting all required functions
module.exports = {
    appendToUserSpreadsheet,
    fetchExpenseData,
    logReceiptExpense,
    getOrCreateUserSpreadsheet
};
