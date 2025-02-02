require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const bodyParser = require('body-parser');
const { parseExpenseMessage } = require('./utils/expenseParser');
const {
    appendToUserSpreadsheet,
    getOrCreateUserSpreadsheet,
    fetchExpenseData,
    calculateExpenseAnalytics,
    setActiveJob,
    getActiveJob
} = require('./utils/googleSheets');
const { extractTextFromImage } = require('./utils/visionService');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ✅ Debugging: Log Environment Variables
console.log("[DEBUG] Checking environment variables...");
console.log("[DEBUG] GOOGLE_CREDENTIALS_BASE64:", process.env.GOOGLE_CREDENTIALS_BASE64 ? "Loaded" : "Missing");
console.log("[DEBUG] FIREBASE_CREDENTIALS_BASE64:", process.env.FIREBASE_CREDENTIALS_BASE64 ? "Loaded" : "Missing");
console.log("[DEBUG] OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "Loaded" : "Missing");

// ✅ Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const environment = process.env.NODE_ENV || 'development';
console.log(`[DEBUG] Environment: ${environment}`);

// ✅ Function to handle setting a new job
async function handleStartJob(from, body) {
    try {
        const jobMatch = body.match(/start job (.+)/i);
        if (!jobMatch) return "⚠️ Please specify a job name. Example: 'Start job 75 Hampton Crt'";

        const jobName = jobMatch[1].trim();
        await setActiveJob(from, jobName);

        console.log(`[✅ SUCCESS] Job set for ${from}: ${jobName}`);
        return `✅ Job '${jobName}' is now active. All expenses will be assigned to this job.`;
    } catch (error) {
        console.error("[ERROR] Failed to start job:", error.message);
        return "❌ Could not start the job. Please try again.";
    }
}

// ✅ Function to handle receipt image processing
async function handleReceiptImage(from, mediaUrl) {
    try {
        console.log(`[DEBUG] Processing receipt image from ${from}: ${mediaUrl}`);
        const extractedText = await extractTextFromImage(mediaUrl);
        if (!extractedText) {
            throw new Error("No text extracted from image.");
        }

        console.log(`[DEBUG] Extracted text: ${extractedText}`);
        const expenseData = parseExpenseMessage(extractedText);

        if (!expenseData) {
            console.error("[ERROR] Failed to parse extracted text into expense data.");
            return "❌ Unable to process receipt. Try entering details manually.";
        }

        console.log(`[DEBUG] Parsed Expense Data:`, expenseData);
        const activeJob = await getActiveJob(from) || "Uncategorized";

        await appendToUserSpreadsheet(
            from,
            [expenseData.date, expenseData.item, expenseData.amount, expenseData.store, activeJob]
        );

        return `✅ Expense logged under '${activeJob}': ${expenseData.item} for ${expenseData.amount} at ${expenseData.store} on ${expenseData.date}`;
    } catch (error) {
        console.error("[ERROR] Failed to process receipt image:", error.message);
        return "❌ Failed to process the receipt image. Please try again later.";
    }
}

// ✅ Webhook to handle incoming messages
app.post('/webhook', async (req, res) => {
    console.log("[DEBUG] Incoming Webhook Request", JSON.stringify(req.body));

    const from = req.body.From;
    const body = req.body.Body?.trim().toLowerCase();
    const mediaUrl = req.body.MediaUrl0; // WhatsApp image URL

    if (!from) {
        console.error("[ERROR] Webhook request missing 'From'.");
        return res.status(400).send("Bad Request: Missing 'From'.");
    }

    console.log(`[DEBUG] Incoming message from ${from}: "${body || "(Image received)"}"`);
    let reply;

    try {
        if (mediaUrl) {
            reply = await handleReceiptImage(from, mediaUrl);
        } else if (body.startsWith("start job ")) {
            reply = await handleStartJob(from, body);
        } else {
            const activeJob = await getActiveJob(from) || "Uncategorized";
            console.log(`[DEBUG] Active job for ${from}: ${activeJob}`);

            // ✅ Parse expense message
            const expenseData = parseExpenseMessage(body);
            console.log(`[DEBUG] Parsed Expense Data:`, expenseData);

            if (expenseData) {
                console.log(`[✅ SUCCESS] Expense detected:`, expenseData);

                try {
                    const spreadsheetId = await getOrCreateUserSpreadsheet(from);
                    if (!spreadsheetId) throw new Error("No spreadsheet ID found.");

                    await appendToUserSpreadsheet(
                        from,
                        [expenseData.date, expenseData.item, expenseData.amount, expenseData.store, activeJob]
                    );

                    reply = `✅ Expense logged under '${activeJob}': ${expenseData.item} for ${expenseData.amount} at ${expenseData.store} on ${expenseData.date}`;
                    console.log(`[DEBUG] Expense logged reply: "${reply}"`);
                } catch (error) {
                    console.error('[ERROR] Failed to log expense to Google Sheets:', error.message);
                    reply = "❌ Failed to log your expense. Please try again later.";
                }
            } else {
                console.error(`[ERROR] Message could not be parsed: "${body}"`);
                reply = "⚠️ I couldn't understand that. Try something like: 'Bought $50 of lumber at Home Depot today'.";
            }
        }
    } catch (error) {
        console.error(`[ERROR] Error handling message from ${from}:`, error);
        reply = "⚠️ Sorry, something went wrong. Please try again later.";
    }

    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Message>${reply}</Message></Response>`);
    console.log(`[DEBUG] Reply sent: "${reply}"`);
});

// ✅ Handle GET requests to verify the server is running
app.get('/', (req, res) => {
    console.log("[DEBUG] GET request received at root URL.");
    res.send("Webhook server is up and running!");
});

// ✅ Start the Express server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`[DEBUG] Webhook server running at http://localhost:${PORT}`);
});

module.exports = app;
