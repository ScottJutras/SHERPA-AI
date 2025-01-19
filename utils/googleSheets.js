const { google } = require('googleapis');
const path = require('path');

// Path to your credentials file
const CREDENTIALS_PATH = path.join(__dirname, '../config/credentials.json'); // Ensure your credentials are placed in this path
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let sheets;

// Function to initialize Google Sheets API client
async function getAuthorizedClient() {
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: CREDENTIALS_PATH,
            scopes: SCOPES,
        });
        console.log('[DEBUG] Google Sheets client authorized successfully.');
        return google.sheets({ version: 'v4', auth });
    } catch (error) {
        console.error('[ERROR] Failed to authorize Google Sheets client:', error);
        throw error;
    }
}

// Function to append data to a Google Sheet
async function appendToGoogleSheet(data) {
    try {
        if (!sheets) {
            sheets = await getAuthorizedClient();
        }

        const SPREADSHEET_ID = '1GK4qIe5fQkyKeSST1X9XVL4r018IKnFZKidT8W2QyaM'; // Replace with your Google Sheets ID
        const RANGE = 'Sheet1!A:D'; // Adjust the range based on your sheet's structure (e.g., columns A to D)

        const resource = {
            values: [data],
        };

        const result = await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: RANGE,
            valueInputOption: 'USER_ENTERED',
            resource,
        });

        console.log(`[DEBUG] Data successfully appended to Google Sheets: ${JSON.stringify(data)}`);
        return result.data;
    } catch (error) {
        console.error('[ERROR] Failed to append data to Google Sheets:', error);
        throw error;
    }
}

module.exports = { appendToGoogleSheet };

