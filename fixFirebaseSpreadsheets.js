require('dotenv').config();
const { google } = require('googleapis');
const admin = require('firebase-admin');
const fs = require('fs');

// Load Firebase credentials
const firebaseCredentialsPath = process.env.FIREBASE_CREDENTIALS;
if (!firebaseCredentialsPath || !fs.existsSync(firebaseCredentialsPath)) {
    console.error("❌ FIREBASE_CREDENTIALS file is missing or incorrect.");
    process.exit(1);
}
const firebaseCredentials = JSON.parse(fs.readFileSync(firebaseCredentialsPath, 'utf8'));

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(firebaseCredentials),
    });
}

const db = admin.firestore();

// Load Google credentials
const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH;
const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

async function createSpreadsheetForUser(phoneNumber) {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
        });

        const sheets = google.sheets({ version: 'v4', auth });

        const response = await sheets.spreadsheets.create({
            resource: {
                properties: {
                    title: `Expenses - ${phoneNumber}`,
                },
            },
        });

        const spreadsheetId = response.data.spreadsheetId;
        console.log(`✅ Created new spreadsheet for ${phoneNumber}: ${spreadsheetId}`);

        // Save to Firebase
        await db.collection('users').doc(phoneNumber).set({ spreadsheetId }, { merge: true });
        console.log(`✅ Updated Firebase for ${phoneNumber}`);

    } catch (error) {
        console.error(`❌ Failed to create spreadsheet for ${phoneNumber}:`, error.message);
    }
}

// Replace with your wife's and your phone numbers
const missingUsers = [
    "whatsapp:+15199652188",
    "whatsapp:+19053279955"
];

missingUsers.forEach(phone => createSpreadsheetForUser(phone));
