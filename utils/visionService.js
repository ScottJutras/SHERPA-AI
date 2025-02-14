const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

// ✅ Document AI Configuration
const PROJECT_ID = process.env.GCP_PROJECT_ID;  // Your actual project ID
// Force the location to lowercase; defaults to "us" if not provided.
const LOCATION = (process.env.GCP_LOCATION || "us").toLowerCase();  
const PROCESSOR_ID = process.env.DOCUMENTAI_PROCESSOR_ID;  // Your Document AI processor ID

if (!process.env.GOOGLE_VISION_CREDENTIALS_BASE64) {
    throw new Error("[ERROR] GOOGLE_VISION_CREDENTIALS_BASE64 is missing. Cannot authenticate Google Vision API.");
}
console.log("[DEBUG] Loading Google Vision API credentials from environment variable.");
const googleVisionCredentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_VISION_CREDENTIALS_BASE64, 'base64').toString('utf-8')
);

// Create a GoogleAuth client for Vision API
const authClient = new GoogleAuth({
    credentials: googleVisionCredentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});


/**
 * Process receipt image with Google Document AI (Receipts Processor).
 *
 * @param {string} imageSource - URL of the receipt image.
 * @returns {Promise<Object|null>} Parsed receipt data or null if failed.
 */
async function extractTextFromImage(imageSource) {
    try {
        console.log(`[DEBUG] Downloading image from: ${imageSource}`);

        // Download the image using Twilio credentials.
        const response = await axios.get(imageSource, {
            responseType: 'arraybuffer',
            auth: {
                username: process.env.TWILIO_ACCOUNT_SID,
                password: process.env.TWILIO_AUTH_TOKEN,
            },
        });

        console.log("[DEBUG] Image downloaded successfully. Sending to Google Document AI...");

        // Construct the Document AI endpoint dynamically using the lowercase LOCATION.
        const endpoint = `https://${LOCATION}-documentai.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/processors/${PROCESSOR_ID}:process`;

        const requestPayload = {
            rawDocument: {
                content: Buffer.from(response.data).toString('base64'),
                mimeType: "image/jpeg",
            },
        };

        // Get an access token from the auth client.
        const accessTokenResponse = await authClient.getAccessToken();
        const accessToken = accessTokenResponse.token || accessTokenResponse;
        const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
        };

        const { data } = await axios.post(endpoint, requestPayload, { headers });

        console.log("[DEBUG] Document AI Response:", JSON.stringify(data, null, 2));

        if (!data.document || !data.document.entities) {
            console.log("[DEBUG] No structured data found in Document AI response.");
            return null;
        }

        const fields = data.document.entities;
        const store = fields.find(f => f.type === "store_name")?.mentionText || "Unknown Store";
        const date = fields.find(f => f.type === "date")?.mentionText || new Date().toISOString().split('T')[0];
        const total = fields.find(f => f.type === "total_amount")?.mentionText || "Unknown Amount";

        console.log(`[DEBUG] Parsed Receipt - Store: ${store}, Date: ${date}, Amount: ${total}`);
        return { store, date, amount: total };

    } catch (error) {
        // Log the complete error response if available.
        if (error.response && error.response.data) {
            console.error("[ERROR] Document AI Failed:", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error("[ERROR] Document AI Failed:", error.message);
        }
        return null;
    }
}

module.exports = { extractTextFromImage };
