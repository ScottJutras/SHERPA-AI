require('dotenv').config();
const admin = require('firebase-admin');
const fs = require('fs');

// Read Firebase credentials
const firebaseCredentialsPath = process.env.FIREBASE_CREDENTIALS;
if (!firebaseCredentialsPath || !fs.existsSync(firebaseCredentialsPath)) {
    console.error("❌ FIREBASE_CREDENTIALS file is missing or incorrect.");
    process.exit(1);
}
const firebaseCredentials = JSON.parse(fs.readFileSync(firebaseCredentialsPath, 'utf8'));

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(firebaseCredentials),
    });
}

const db = admin.firestore();

async function listUsersAndSpreadsheets() {
    try {
        const usersSnapshot = await db.collection('users').get();
        console.log("\n📂 Firebase Users & Spreadsheet IDs:\n");

        usersSnapshot.forEach((doc) => {
            const userData = doc.data();
            console.log(`📞 Phone Number: ${doc.id}`);
            console.log(`📄 Spreadsheet ID: ${userData.spreadsheetId || '❌ No Spreadsheet Found'}`);
            console.log("------------------------------------------------");
        });

    } catch (error) {
        console.error("❌ Failed to retrieve Firebase users:", error.message);
    }
}

listUsersAndSpreadsheets();
