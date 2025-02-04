const vision = require('@google-cloud/vision');
const axios = require('axios');

// ✅ Initialize Cloud Vision API client using Environment Variable
const { GoogleAuth } = require('google-auth-library');

if (process.env.GOOGLE_CREDENTIALS_BASE64) {
    console.log("[DEBUG] Loading Google Vision credentials from environment variable.");
    const googleCredentials = JSON.parse(
        Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
    );

    var client = new vision.ImageAnnotatorClient({
        credentials: googleCredentials
    });
} else {
    throw new Error("[ERROR] GOOGLE_CREDENTIALS_BASE64 is missing. Cannot authenticate Google Vision API.");
}

/**
 * Extract text from an image using Google Cloud Vision API.
 * Supports URLs (downloads first), Buffers, and local paths.
 *
 * @param {string|Buffer} imageSource - Path, URL, or Buffer of an image.
 * @returns {Promise<string|null>} Extracted text or null if no text is found.
 */
async function extractTextFromImage(imageSource) {
    try {
        let request = {};

        // ✅ If the image is a URL, download it first
        if (typeof imageSource === 'string' && imageSource.startsWith('http')) {
            console.log(`[DEBUG] Downloading image from: ${imageSource}`);

            // Authenticate with Twilio (use Twilio credentials)
            const response = await axios.get(imageSource, {
                responseType: 'arraybuffer',
                auth: {
                    username: process.env.TWILIO_ACCOUNT_SID,
                    password: process.env.TWILIO_AUTH_TOKEN
                }
            });
            

            console.log("[DEBUG] Image downloaded successfully. Sending to Google Vision...");
            request.image = { content: Buffer.from(response.data).toString('base64') };
        } else if (Buffer.isBuffer(imageSource)) {
            request.image = { content: imageSource.toString('base64') };
        } else {
            request.image = { source: { filename: imageSource } };
        }

        // Perform text detection
        const [result] = await client.textDetection(request);
        console.log("[DEBUG] Google Vision API Response:", JSON.stringify(result, null, 2));

        const detections = result.textAnnotations;

        if (!detections || detections.length === 0) {
            console.log("[DEBUG] No text found in image.");
            return null;
        }

        // Extracted text
        const extractedText = detections[0].description.trim();
        console.log(`[DEBUG] Extracted text:\n${extractedText}`);

        return extractedText;
    } catch (error) {
        console.error("[ERROR] Failed to process image:", error.message);
        return null;
    }
}

module.exports = { extractTextFromImage };
