require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');

// Load Google credentials
const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH;
if (!credentialsPath || !fs.existsSync(credentialsPath)) {
    console.error("❌ ERROR: GOOGLE_CREDENTIALS_PATH is missing or incorrect.");
    process.exit(1);
}
const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

async function listSpreadsheets() {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly'],
        });

        const drive = google.drive({ version: 'v3', auth });

        const response = await drive.files.list({
            q: "mimeType='application/vnd.google-apps.spreadsheet'",
            fields: 'files(id, name, owners)',
        });

        console.log("📂 Spreadsheets Created by the Service Account:");
        response.data.files.forEach(file => {
            console.log(`📄 ${file.name} (ID: ${file.id}) - Owner: ${file.owners.map(owner => owner.emailAddress).join(', ')}`);
        });

    } catch (error) {
        console.error("❌ Failed to list spreadsheets:", error.message);
    }
}

listSpreadsheets();
