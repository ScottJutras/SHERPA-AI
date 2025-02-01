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

// Function to initialize Google API client
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

// Function to share the spreadsheet with a user
async function shareSpreadsheetWithUser(spreadsheetId, email) {
    try {
        const auth = await getAuthorizedClient();
        const drive = google.drive({ version: 'v3', auth });

        await drive.permissions.create({
            fileId: spreadsheetId,
            requestBody: {
                role: 'writer', // Change to 'reader' if you only need view access
                type: 'user',
                emailAddress: email,
            },
            sendNotificationEmail: true,
        });

        console.log(`[✅ SUCCESS] Spreadsheet (${spreadsheetId}) successfully shared with ${email}`);
    } catch (error) {
        console.error(`[❌ ERROR] Failed to share spreadsheet (${spreadsheetId}) with ${email}:`, error.message);
    }
}

// Function to create a new spreadsheet and share it
async function createSpreadsheetForUser(phoneNumber) {
    try {
        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });

        const request = {
            resource: {
                properties: {
                    title: `Expenses - ${phoneNumber}`, // Name the spreadsheet after the user
                },
            },
        };

        const response = await sheets.spreadsheets.create(request);
        const spreadsheetId = response.data.spreadsheetId;

        console.log(`[✅ SUCCESS] New spreadsheet created for user (${phoneNumber}): ${spreadsheetId}`);

        // Share the spreadsheet with your personal email
        const personalEmail = process.env.PERSONAL_EMAIL;
        if (personalEmail) {
            await shareSpreadsheetWithUser(spreadsheetId, personalEmail);
        } else {
            console.warn('[⚠️ WARN] PERSONAL_EMAIL is not set. Spreadsheet will not be shared.');
        }

        return spreadsheetId;
    } catch (error) {
        console.error('[❌ ERROR] Failed to create a new spreadsheet:', error.message);
        throw error;
    }
}

// Function to append data to a user's spreadsheet
async function appendToUserSpreadsheet(data, spreadsheetId) {
    try {
        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });

        console.log(`[DEBUG] Using Spreadsheet ID: ${spreadsheetId}`);

        const RANGE = 'Sheet1!A:D';

        const resource = {
            values: [data],
        };

        const result = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: RANGE,
            valueInputOption: 'USER_ENTERED',
            resource,
        });

        console.log(`[✅ SUCCESS] Data successfully appended to spreadsheet (${spreadsheetId}): ${JSON.stringify(data)}`);
        return result.data;
    } catch (error) {
        console.error('[❌ ERROR] Failed to append data to spreadsheet:', error.message);
        throw error;
    }
}

// Function to retrieve or create a spreadsheet for a user and share it
async function getOrCreateUserSpreadsheet(phoneNumber) {
    try {
        const userDoc = db.collection('users').doc(phoneNumber);
        const userSnapshot = await userDoc.get();

        // Check if spreadsheet ID exists in Firebase
        if (userSnapshot.exists && userSnapshot.data().spreadsheetId) {
            const spreadsheetId = userSnapshot.data().spreadsheetId;
            console.log(`[DEBUG] Retrieved spreadsheet ID from Firebase for user (${phoneNumber}): ${spreadsheetId}`);

            // 🔹 Ensure the spreadsheet is shared with your personal email
            const personalEmail = process.env.PERSONAL_EMAIL;
            if (personalEmail) {
                console.log(`[DEBUG] Ensuring spreadsheet ${spreadsheetId} is shared with ${personalEmail}`);
                await shareSpreadsheetWithUser(spreadsheetId, personalEmail);
            } else {
                console.warn('[⚠️ WARN] PERSONAL_EMAIL is not set. Cannot ensure access.');
            }

            return spreadsheetId;
        }

        // If no spreadsheet exists, create a new one
        console.log(`[DEBUG] No spreadsheet found for user (${phoneNumber}). Creating a new one.`);
        const spreadsheetId = await createSpreadsheetForUser(phoneNumber);

        // ✅ Save the spreadsheet ID to Firebase, ensuring existing data is not lost
        await userDoc.set({ spreadsheetId }, { merge: true });
        console.log(`[✅ SUCCESS] Spreadsheet created and saved to Firebase for user (${phoneNumber}): ${spreadsheetId}`);

        return spreadsheetId;
    } catch (error) {
        console.error(`[❌ ERROR] Failed to retrieve or create spreadsheet for user (${phoneNumber}):`, error.message);
        throw error;
    }
}

module.exports = {
    appendToUserSpreadsheet,
    getOrCreateUserSpreadsheet,
};
