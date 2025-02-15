const fs = require('fs');
const path = "C:\\Users\\scott\\Documents\\Sherpa AI\\Config\\firebase-credentials.json";

// Read the file content
const creds = fs.readFileSync(path, 'utf8');

// Encode the content to base64
const base64Encoded = Buffer.from(creds, 'utf8').toString('base64');
console.log(base64Encoded);
