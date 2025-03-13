const { db } = require('./firebase');

async function updateUserSpreadsheet() {
    const phoneNumber = "YOUR_PHONE_NUMBER"; // Replace with your actual phone number
    const spreadsheetId = "1mb83t9mvuJJ68XsHd6nw1nrm4SmgrNkDrgAnizi4iWU";

    try {
        await db.collection('users').doc(phoneNumber).set({ spreadsheetId }, { merge: true });
        console.log(`✅ Successfully updated Firebase with new Spreadsheet ID: ${spreadsheetId}`);
    } catch (error) {
        console.error(`❌ Failed to update Firebase: ${error.message}`);
    }
}

updateUserSpreadsheet();