require('dotenv').config();
const { google } = require('googleapis');
const admin = require('firebase-admin');
const fs = require('fs');

// Load Google credentials from file
const credentialsPath = "./google_credentials.json"; // Explicit file path
if (!fs.existsSync(credentialsPath)) {
    throw new Error(`❌ Credentials file not found at ${credentialsPath}`);
}

// Read and parse the credentials file
const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

// Initialize Firebase Admin
if (!admin.apps.length) {
    const firebaseCredentials = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
    admin.initializeApp({
        credential: admin.credential.cert(firebaseCredentials),
    });
}

const db = admin.firestore();

// Authenticate Google Drive API
async function getAuthorizedClient() {
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive'],
    });
    return auth;
}

// Share a Spreadsheet with Your Personal Email
async function shareSpreadsheet(spreadsheetId, email) {
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
            sendNotificationEmail: true,
        });

        console.log(`✅ Shared spreadsheet (${spreadsheetId}) with ${email}`);
    } catch (error) {
        console.error(`❌ Failed to share spreadsheet ${spreadsheetId}:`, error.message);
    }
}

// Get All Spreadsheets from Firebase and Share Them
async function shareAllSpreadsheets() {
    try {
        const usersSnapshot = await db.collection('users').get();
        const personalEmail = process.env.PERSONAL_EMAIL;

        if (!personalEmail) {
            throw new Error('❌ PERSONAL_EMAIL is not set in .env.');
        }

        for (const doc of usersSnapshot.docs) {
            const data = doc.data();
            if (data.spreadsheetId) {
                console.log(`🔹 Sharing spreadsheet ${data.spreadsheetId}...`);
                await shareSpreadsheet(data.spreadsheetId, personalEmail);
            }
        }

        console.log('✅ Finished sharing all spreadsheets.');
    } catch (error) {
        console.error('❌ Error sharing spreadsheets:', error.message);
    }
}

// Run the script
shareAllSpreadsheets().catch(console.error);
