const admin = require('firebase-admin');
const fs = require('fs');

// Load Firebase credentials from JSON file
const firebaseCredentialsPath = process.env.FIREBASE_CREDENTIALS;

if (!firebaseCredentialsPath || !fs.existsSync(firebaseCredentialsPath)) {
    console.error("❌ FIREBASE_CREDENTIALS file is missing or incorrect. Check the path in your .env file.");
    process.exit(1);
}

const firebaseCredentials = JSON.parse(fs.readFileSync(firebaseCredentialsPath, 'utf8'));

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(firebaseCredentials),
    });
}

const db = admin.firestore();

async function updateUserSpreadsheet() {
    const phoneNumber = "YOUR_PHONE_NUMBER"; // Replace with your actual phone number
    const spreadsheetId = "1mb83t9mvuJJ68XsHd6nw1nrm4SmgrNkDrgAnizi4iWU"; // ✅ New Spreadsheet ID

    try {
        await db.collection('users').doc(phoneNumber).set({ spreadsheetId }, { merge: true });
        console.log(`✅ Successfully updated Firebase with new Spreadsheet ID: ${spreadsheetId}`);
    } catch (error) {
        console.error(`❌ Failed to update Firebase: ${error.message}`);
    }
}

updateUserSpreadsheet();
