const { google } = require('googleapis');
const fs = require('fs');
require('dotenv').config(); // Ensure .env variables are loaded

async function shareSpreadsheet(spreadsheetId, email) {
    try {
        // Read credentials from JSON file only
        const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || './google_credentials.json';

        if (!fs.existsSync(credentialsPath)) {
            throw new Error(`❌ Credentials file not found: ${credentialsPath}`);
        }

        const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive'],
        });

        const drive = google.drive({ version: 'v3', auth });

        await drive.permissions.create({
            fileId: spreadsheetId,
            requestBody: {
                role: 'writer', // Change to 'reader' for view-only access
                type: 'user',
                emailAddress: email,
            },
            sendNotificationEmail: true,
        });

        console.log(`✅ Spreadsheet ${spreadsheetId} successfully shared with ${email}`);
    } catch (error) {
        console.error(`❌ Failed to share spreadsheet: ${error.message}`);
    }
}

// Replace these values before running the script
const spreadsheetId = "1mb83t9mvuJJ68XsHd6nw1nrm4SmgrNkDrgAnizi4iWU";
const email = "scottejutras@gmail.com";

shareSpreadsheet(spreadsheetId, email).catch(console.error);
