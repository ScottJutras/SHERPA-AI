require('dotenv').config();
const admin = require('firebase-admin');

if (!admin.apps.length) {
    const firebaseCredentials = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
    admin.initializeApp({
        credential: admin.credential.cert(firebaseCredentials),
    });
}

const db = admin.firestore();

async function updateUserSpreadsheet() {
    const phoneNumber = "YOUR_PHONE_NUMBER"; // Replace with your actual number
    const spreadsheetId = "1mb83t9mvuJJ68XsHd6nw1nrm4SmgrNkDrgAnizi4iWU"; // New Spreadsheet ID

    try {
        await db.collection('users').doc(phoneNumber).set({ spreadsheetId }, { merge: true });
        console.log(`✅ Successfully updated Firebase with new Spreadsheet ID: ${spreadsheetId}`);
    } catch (error) {
        console.error(`❌ Failed to update Firebase: ${error.message}`);
    }
}

updateUserSpreadsheet();
