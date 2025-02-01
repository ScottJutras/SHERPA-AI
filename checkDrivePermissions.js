require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');

// Load Google credentials
const credentialsPath = process.env.GOOGLE_CREDENTIALS;
const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

async function checkPermissions(spreadsheetId) {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive'],
        });

        const drive = google.drive({ version: 'v3', auth });

        const response = await drive.permissions.list({ fileId: spreadsheetId });
        console.log(`🔍 Permissions for Spreadsheet ID: ${spreadsheetId}\n`, response.data.permissions);
    } catch (error) {
        console.error(`❌ Failed to check permissions for ${spreadsheetId}:`, error.message);
    }
}

// Replace with the spreadsheet IDs you want to check
const spreadsheetIds = ["1dIKcnzx2w_WVZoLGASC97qX7DVpK5lGqVO8sge_nKyg", "15eVVA03orU7VIw2Tm69G4pyVsd_aAqfw2shu1bJykMk"];

spreadsheetIds.forEach(checkPermissions);
