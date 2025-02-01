const { google } = require('googleapis');
const fs = require('fs');

// Load Google credentials from file
const credentialsPath = "./google_credentials.json"; // Explicit file path
if (!fs.existsSync(credentialsPath)) {
    throw new Error(`❌ Credentials file not found at ${credentialsPath}`);
}

// Read and parse the credentials file
const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

// Authenticate Google Drive API
async function listFiles() {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive'],
        });

        const drive = google.drive({ version: 'v3', auth });

        // List first 100 files owned by the service account
        const res = await drive.files.list({
            pageSize: 100,
            fields: 'files(id, name, mimeType)',
        });

        console.log('📂 Files in the service account’s Drive:');
        res.data.files.forEach(file => {
            console.log(`- ${file.name} (${file.id}) [${file.mimeType}]`);
        });

    } catch (error) {
        console.error('❌ Error listing files:', error.message);
    }
}

listFiles().catch(console.error);
