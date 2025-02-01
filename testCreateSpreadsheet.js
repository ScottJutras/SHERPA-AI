const { google } = require('googleapis');
const fs = require('fs');

// Load Google credentials from file
const credentialsPath = "./google_credentials.json";
if (!fs.existsSync(credentialsPath)) {
    throw new Error(`❌ Credentials file not found at ${credentialsPath}`);
}

const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

// Authenticate Google Sheets API
async function createSpreadsheet() {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const sheets = google.sheets({ version: 'v4', auth });

        const request = {
            resource: {
                properties: {
                    title: `Expenses - TestUser`, // Test spreadsheet
                },
            },
        };

        const response = await sheets.spreadsheets.create(request);
        const spreadsheetId = response.data.spreadsheetId;

        console.log(`✅ Successfully created spreadsheet: ${spreadsheetId}`);

        return spreadsheetId;
    } catch (error) {
        console.error('❌ Failed to create spreadsheet:', error.message);
    }
}

createSpreadsheet().catch(console.error);
