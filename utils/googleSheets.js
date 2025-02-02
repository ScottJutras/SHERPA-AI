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

// Scopes required for Google Sheets and Drive APIs
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

// ✅ Function to create a new spreadsheet for a user
async function createSpreadsheetForUser(phoneNumber) {
    try {
        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });

        const request = {
            resource: {
                properties: {
                    title: `Expenses - ${phoneNumber}`,
                },
            },
        };

        const response = await sheets.spreadsheets.create(request);
        const spreadsheetId = response.data.spreadsheetId;

        console.log(`[✅ SUCCESS] New spreadsheet created for user (${phoneNumber}): ${spreadsheetId}`);
        return spreadsheetId;
    } catch (error) {
        console.error('[❌ ERROR] Failed to create a new spreadsheet:', error.message);
        throw error;
    }
}

// ✅ Function to set the active job for a user
async function setActiveJob(phoneNumber, jobName) {
    try {
        await db.collection('users').doc(phoneNumber).set({ activeJob: jobName }, { merge: true });
        console.log(`[✅ SUCCESS] Active job set for user (${phoneNumber}): ${jobName}`);
    } catch (error) {
        console.error('[❌ ERROR] Failed to set active job:', error.message);
        throw error;
    }
}

// ✅ Function to get the active job for a user
async function getActiveJob(phoneNumber) {
    try {
        const userDoc = await db.collection('users').doc(phoneNumber).get();
        return userDoc.exists ? userDoc.data().activeJob : null;
    } catch (error) {
        console.error('[❌ ERROR] Failed to retrieve active job:', error.message);
        throw error;
    }
}

// ✅ Function to append data to a user's spreadsheet, including job name
async function appendToUserSpreadsheet(phoneNumber, data) {
    try {
        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });

        console.log(`[DEBUG] Retrieving active job for ${phoneNumber}`);
        const jobName = await getActiveJob(phoneNumber) || "Unassigned";

        console.log(`[DEBUG] Active job found: ${jobName}`);

        const spreadsheetId = await getOrCreateUserSpreadsheet(phoneNumber);
        console.log(`[DEBUG] Using Spreadsheet ID: ${spreadsheetId}`);

        const RANGE = 'Sheet1!A:E'; // Columns: Date, Item, Amount, Store, Job

        const resource = {
            values: [[...data, jobName]], // Append job name to data
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
            .filter(row => row[4] === jobName) // Filter by job name
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

// ✅ Function to retrieve or create a spreadsheet for a user
async function getOrCreateUserSpreadsheet(phoneNumber) {
    try {
        const userDoc = db.collection('users').doc(phoneNumber);
        const userSnapshot = await userDoc.get();

        if (userSnapshot.exists && userSnapshot.data().spreadsheetId) {
            const spreadsheetId = userSnapshot.data().spreadsheetId;
            console.log(`[DEBUG] Retrieved spreadsheet ID from Firebase for user (${phoneNumber}): ${spreadsheetId}`);
            return spreadsheetId;
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

// ✅ Exporting all required functions
module.exports = {
    appendToUserSpreadsheet,
    fetchExpenseData,
    calculateExpenseAnalytics,
    setActiveJob,
    getActiveJob,
    getOrCreateUserSpreadsheet
};
