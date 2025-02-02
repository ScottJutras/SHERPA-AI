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
        let date = new Date().toISOString().split('T')[0];
        let amount = null;
        let store = lines[0] || "Unknown Store";
        let items = [];
        
        lines.forEach(line => {
            const amountMatch = line.match(/\$([\d,]+(?:\.\d{1,2})?)/);
            if (amountMatch) amount = `$${amountMatch[1]}`;

            const itemMatch = line.match(/([a-zA-Z\s]+)\s+\$?[\d,]+(?:\.\d{1,2})?/);
            if (itemMatch) items.push(itemMatch[1].trim());
        });

        return {
            date,
            item: items.join(", ") || "Unknown Items",
            amount: amount || "Unknown Amount",
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
