const vision = require('@google-cloud/vision');

// Initialize Cloud Vision API client using Environment Variable
const { GoogleAuth } = require('google-auth-library');

// ✅ Check if running in Vercel and load credentials from environment
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
 * Supports both local image paths and URLs.
 *
 * @param {string|Buffer} imageSource - Path, URL, or Buffer of an image.
 * @returns {Promise<string|null>} Extracted text or null if no text is found.
 */
async function extractTextFromImage(imageSource) {
    try {
        let request = {};

        // Determine if the input is a URL, local path, or a Buffer
        if (Buffer.isBuffer(imageSource)) {
            request.image = { content: imageSource.toString('base64') };
        } else if (imageSource.startsWith('http')) {
            request.image = { source: { imageUri: imageSource } };
        } else {
            request.image = { source: { filename: imageSource } };
        }

        // Perform text detection
        const [result] = await client.textDetection(request);
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
