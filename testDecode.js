// testDecode.js
const credsBase64 = process.env.FIREBASE_CREDENTIALS_BASE64;
if (!credsBase64) {
  throw new Error("FIREBASE_CREDENTIALS_BASE64 environment variable is not set.");
}

// Decode the base64 string
const decoded = Buffer.from(credsBase64, 'base64').toString('utf8');
console.log("Decoded Credentials:", decoded);

// Validate that the decoded string is valid JSON
try {
  const parsed = JSON.parse(decoded);
  console.log("Parsed JSON successfully:", parsed);
} catch (error) {
  console.error("Error parsing JSON:", error);
}
