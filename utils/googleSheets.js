const { google } = require('googleapis');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
    const firebaseCredentialsBase64 = process.env.FIREBASE_CREDENTIALS_BASE64; // Base64 string from environment variable
    if (!firebaseCredentialsBase64) {
        throw new Error('[ERROR] FIREBASE_CREDENTIALS_BASE64 is not set in environment variables.');
    }
    try {
        const firebaseCredentials = JSON.parse(
            Buffer.from(firebaseCredentialsBase64, 'base64').toString('utf-8')
        );

        console.log('[DEBUG] Initializing Firebase with decoded credentials.');
        admin.initializeApp({
            credential: admin.credential.cert(firebaseCredentials),
        });
        console.log('[DEBUG] Firebase Admin initialized successfully.');
    } catch (error) {
        console.error('[ERROR] Failed to initialize Firebase Admin:', error.message);
        throw error;
    }
}

const db = admin.firestore();

// Scopes required for Google Sheets API
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'];

let sheets;

// Function to initialize Google Sheets API client using environment variables
async function getAuthorizedClient() {
    try {
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: credentials.client_email,
                private_key: credentials.private_key,
            },
            scopes: SCOPES,
        });

        console.log('[DEBUG] Google Sheets client authorized successfully.');
        return google.sheets({ version: 'v4', auth });
    } catch (error) {
        console.error('[ERROR] Failed to authorize Google Sheets client:', error.message);
        throw error;
    }
}

// Function to share the spreadsheet with a user
async function shareSpreadsheetWithUser(spreadsheetId, email) {
    try {
        const auth = await getAuthorizedClient();
        const drive = google.drive({ version: 'v3', auth });

        await drive.permissions.create({
            fileId: spreadsheetId,
            requestBody: {
                role: 'writer',
                type: 'user',
                emailAddress: email,
            },
        });

        console.log(`[DEBUG] Spreadsheet (${spreadsheetId}) successfully shared with ${email}`);
    } catch (error) {
        console.error(`[ERROR] Failed to share spreadsheet (${spreadsheetId}) with ${email}:`, error.message);
    }
}

// Function to create a new spreadsheet for a user
async function createSpreadsheetForUser(phoneNumber) {
    try {
        const auth = await getAuthorizedClient();
        const request = {
            resource: {
                properties: {
                    title: `Expenses - ${phoneNumber}`, // Name the spreadsheet after the user
                },
            },
        };

        const response = await auth.spreadsheets.create(request);
        const spreadsheetId = response.data.spreadsheetId;

        console.log(`[DEBUG] New spreadsheet created for user (${phoneNumber}): ${spreadsheetId}`);

        // Share the spreadsheet with your personal email
        const personalEmail = process.env.PERSONAL_EMAIL; // Ensure your personal email is set in .env
        if (personalEmail) {
            await shareSpreadsheetWithUser(spreadsheetId, personalEmail);
        } else {
            console.warn('[WARN] PERSONAL_EMAIL is not set. Spreadsheet will not be shared.');
        }

        return spreadsheetId;
    } catch (error) {
        console.error('[ERROR] Failed to create a new spreadsheet:', error.message);
        throw error;
    }
}

// Function to append data to a user's spreadsheet
async function appendToUserSpreadsheet(data, spreadsheetId) {
    try {
        if (!sheets) {
            sheets = await getAuthorizedClient();
        }

        console.log(`[DEBUG] Using Spreadsheet ID: ${spreadsheetId}`);

        const RANGE = 'Sheet1!A:D'; // Default range in the spreadsheet

        const resource = {
            values: [data],
        };

        const result = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: RANGE,
            valueInputOption: 'USER_ENTERED',
            resource,
        });

        console.log(`[DEBUG] Data successfully appended to spreadsheet (${spreadsheetId}): ${JSON.stringify(data)}`);
        return result.data;
    } catch (error) {
        console.error('[ERROR] Failed to append data to spreadsheet:', error.message);
        throw error;
    }
}

// Function to retrieve or create a spreadsheet for a user
async function getOrCreateUserSpreadsheet(phoneNumber) {
    try {
        const userDoc = db.collection('users').doc(phoneNumber);
        const userSnapshot = await userDoc.get();

        // Check if spreadsheet ID exists in Firebase
        if (userSnapshot.exists && userSnapshot.data().spreadsheetId) {
            const spreadsheetId = userSnapshot.data().spreadsheetId;
            console.log(`[DEBUG] Retrieved spreadsheet ID from Firebase for user (${phoneNumber}): ${spreadsheetId}`);
            return spreadsheetId;
        }

        // If no spreadsheet exists, create a new one
        console.log(`[DEBUG] No spreadsheet found for user (${phoneNumber}). Creating a new one.`);
        const spreadsheetId = await createSpreadsheetForUser(phoneNumber);

        // Save the spreadsheet ID to Firebase
        await userDoc.set({ spreadsheetId });
        console.log(`[DEBUG] Spreadsheet created and saved to Firebase for user (${phoneNumber}): ${spreadsheetId}`);

        return spreadsheetId;
    } catch (error) {
        console.error(`[ERROR] Failed to retrieve or create spreadsheet for user (${phoneNumber}):`, error.message);
        throw error;
    }
}

module.exports = {
    appendToUserSpreadsheet,
    getOrCreateUserSpreadsheet,
};
