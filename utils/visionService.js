const axios = require('axios');

// ✅ Document AI Configuration
const PROJECT_ID = "YOUR_PROJECT_ID";  // Replace with your actual Google Cloud project ID
const LOCATION = "us";  // Keep "us" unless your processor is in a different region
const PROCESSOR_ID = "8fe848506d8e86c6";  // Your Document AI processor ID

// ✅ Google Authentication
const { GoogleAuth } = require('google-auth-library');
if (!process.env.GOOGLE_CREDENTIALS_BASE64) {
    throw new Error("[ERROR] GOOGLE_CREDENTIALS_BASE64 is missing. Cannot authenticate Document AI.");
}
console.log("[DEBUG] Loading Google Document AI credentials from environment variable.");
const googleCredentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
);
const authClient = new GoogleAuth({ credentials: googleCredentials }).fromJSON(googleCredentials);

/**
 * Process receipt image with Google Document AI (Receipts Processor).
 *
 * @param {string} imageSource - URL of the receipt image.
 * @returns {Promise<Object|null>} Parsed receipt data or null if failed.
 */
async function extractTextFromImage(imageSource) {
    try {
        console.log(`[DEBUG] Downloading image from: ${imageSource}`);

        // Download the image using Twilio credentials
        const response = await axios.get(imageSource, {
            responseType: 'arraybuffer',
            auth: {
                username: process.env.TWILIO_ACCOUNT_SID,
                password: process.env.TWILIO_AUTH_TOKEN
            }
        });

        console.log("[DEBUG] Image downloaded successfully. Sending to Google Document AI...");

        const endpoint = `https://${LOCATION}-documentai.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/processors/${PROCESSOR_ID}:process`;

        const requestPayload = {
            rawDocument: {
                content: Buffer.from(response.data).toString('base64'),
                mimeType: "image/jpeg"
            }
        };

        const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${await authClient.getAccessToken()}`
        };

        const { data } = await axios.post(endpoint, requestPayload, { headers });

        console.log("[DEBUG] Document AI Response:", JSON.stringify(data, null, 2));

        if (!data.document || !data.document.entities) {
            console.log("[DEBUG] No structured data found in Document AI response.");
            return null;
        }

        let fields = data.document.entities;
        let store = fields.find(f => f.type === "store_name")?.mentionText || "Unknown Store";
        let date = fields.find(f => f.type === "date")?.mentionText || new Date().toISOString().split('T')[0];
        let total = fields.find(f => f.type === "total_amount")?.mentionText || "Unknown Amount";

        console.log(`[DEBUG] Parsed Receipt - Store: ${store}, Date: ${date}, Amount: ${total}`);
        return { store, date, amount: total };

    } catch (error) {
        console.error("[ERROR] Document AI Failed:", error.message);
        return null;
    }
}

module.exports = { extractTextFromImage };
