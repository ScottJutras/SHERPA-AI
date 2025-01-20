const { google } = require('googleapis');

// Scopes required for Google Sheets API
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let sheets;

// Function to initialize Google Sheets API client using environment variables
async function getAuthorizedClient() {
    try {
        // Retrieve credentials from environment variable
        const credentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);

        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: credentials.client_email,
                private_key: credentials.private_key,
            },
            scopes: SCOPES,
        });

        console.log('[DEBUG] Google Sheets client authorized successfully.');
        return google.sheets({ version: 'v4', auth });
    } catch (error) {
        console.error('[ERROR] Failed to authorize Google Sheets client:', error.message);
        throw error;
    }
}

// Function to append data to a Google Sheet
async function appendToGoogleSheet(data) {
    try {
        if (!sheets) {
            sheets = await getAuthorizedClient();
        }

        // Retrieve spreadsheet ID from environment variables
        const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

        // Debugging the retrieval of SPREADSHEET_ID
        console.log(`[DEBUG] Retrieved GOOGLE_SHEET_ID: ${SPREADSHEET_ID}`);

        if (!SPREADSHEET_ID) {
            console.error('[ERROR] GOOGLE_SHEET_ID is not set in environment variables.');
            throw new Error('GOOGLE_SHEET_ID is missing');
        }

        const RANGE = 'Sheet1!A:D'; // Adjust the range based on your sheet's structure

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
        console.error('[ERROR] Failed to append data to Google Sheets:', error.message);
        throw error;
    }
}

module.exports = { appendToGoogleSheet };




