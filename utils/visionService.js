const vision = require('@google-cloud/vision');

// Initialize Cloud Vision API client using Environment Variable
const client = new vision.ImageAnnotatorClient();

/**
 * Extract text from an image using Google Cloud Vision API.
 * Supports both local image paths and URLs.
 *
 * @param {string|Buffer} imageSource - Path, URL, or Buffer of an image.
 * @returns {Promise<string|null>} Extracted text or null if no text is found.
 */
async function extractTextFromImage(imageSource) {
    try {
        console.log(`[DEBUG] Received image source: ${imageSource}`);
        let request = {};

        // Determine if the input is a URL, local path, or a Buffer
        if (Buffer.isBuffer(imageSource)) {
            request.image = { content: imageSource.toString('base64') };
            console.log("[DEBUG] Processing image from Buffer.");
        } else if (imageSource.startsWith('http')) {
            request.image = { source: { imageUri: imageSource } };
            console.log(`[DEBUG] Processing image from URL: ${imageSource}`);
        } else {
            request.image = { source: { filename: imageSource } };
            console.log(`[DEBUG] Processing local image file: ${imageSource}`);
        }

        // Perform text detection
        console.log("[DEBUG] Sending image to Google Vision API...");
        const [result] = await client.textDetection(request);
        console.log("[DEBUG] Received response from Google Vision API.");
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
