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

// ✅ Function to get job-based expense summary
async function getJobExpenseSummary(from, jobName) {
    try {
        console.log(`[DEBUG] Fetching expense summary for job: ${jobName}, user: ${from}`);

        const expenseData = await fetchExpenseData(from, jobName);
        console.log(`[DEBUG] Retrieved expense data:`, JSON.stringify(expenseData, null, 2));

        if (!expenseData.length) {
            return `⚠️ No expenses found for job: ${jobName}`;
        }

        const analytics = calculateExpenseAnalytics(expenseData);
        console.log(`[DEBUG] Expense Analytics:`, JSON.stringify(analytics, null, 2));

        return `
📊 *Expense Summary for ${jobName}* 📊
💰 Total Spent: ${analytics.totalSpent}
🏪 Top Store: ${analytics.topStore}
📌 Biggest Purchase: ${analytics.biggestPurchase}
🔄 Most Frequent Expense: ${analytics.mostFrequentItem}
        `;
    } catch (error) {
        console.error('[ERROR] Failed to fetch job expense summary:', error.message);
        return `⚠️ Unable to generate expense summary for ${jobName}. Please try again later.`;
    }
    function calculateExpenseAnalytics(expenseData) {
    if (!expenseData || expenseData.length === 0) {
        return null;
    }

    let totalSpent = 0;
    let storeCount = {};
    let itemCount = {};
    let biggestPurchase = { item: null, amount: 0 };

    for (const expense of expenseData) {
        totalSpent += expense.amount;

        // Track store frequency
        if (storeCount[expense.store]) {
            storeCount[expense.store]++;
        } else {
            storeCount[expense.store] = 1;
        }

        // Track item frequency
        if (itemCount[expense.item]) {
            itemCount[expense.item]++;
        } else {
            itemCount[expense.item] = 1;
        }

        // Find the biggest purchase
        if (expense.amount > biggestPurchase.amount) {
            biggestPurchase = { item: expense.item, amount: expense.amount };
        }
    }

    // Find most frequent store & item
    let topStore = Object.keys(storeCount).reduce((a, b) => (storeCount[a] > storeCount[b] ? a : b));
    let mostFrequentItem = Object.keys(itemCount).reduce((a, b) => (itemCount[a] > itemCount[b] ? a : b));

    return {
        totalSpent: `$${totalSpent.toFixed(2)}`,
        topStore,
        biggestPurchase: `${biggestPurchase.item} for $${biggestPurchase.amount.toFixed(2)}`,
        mostFrequentItem
    };
}
}

// ✅ Function to handle setting a new job
async function handleStartJob(from, body) {
    const jobMatch = body.match(/start job (.+)/i);
    if (!jobMatch) return "⚠️ Please specify a job name. Example: 'Start job 75 Hampton Crt'";

    const jobName = jobMatch[1].trim();
    await setActiveJob(from, jobName);
    
    return `✅ Job '${jobName}' is now active. All expenses will be assigned to this job.`;
}

// ✅ Function to handle receipt image processing
async function handleReceiptImage(from, mediaUrl) {
    try {
        console.log(`[DEBUG] Processing receipt image from ${from}: ${mediaUrl}`);

        if (!mediaUrl) {
            throw new Error("Media URL is missing or invalid.");
        }

        // Extract text from the image
        const extractedText = await extractTextFromImage(mediaUrl);

        if (!extractedText) {
            throw new Error("No text extracted from image.");
        }

        console.log(`[DEBUG] Extracted text: ${extractedText}`);

        // Parse receipt text
        const expenseData = parseExpenseMessage(extractedText);
        if (!expenseData) {
            throw new Error("Failed to parse extracted text into expense data.");
        }

        console.log(`[DEBUG] Parsed Expense Data:`, expenseData);
        const activeJob = await getActiveJob(from) || "Uncategorized";

        // Append data to Google Sheets
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

// ✅ Function to get response from ChatGPT
async function getChatGPTResponse(prompt) {
    try {
        console.log(`[DEBUG] ChatGPT Request: "${prompt}"`);
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: 'You are a helpful assistant.' },
                { role: 'user', content: prompt },
            ],
            max_tokens: 100,
            temperature: 0.7,
        });

        return response.choices?.[0]?.message?.content?.trim() || "Sorry, I didn't understand that.";
    } catch (error) {
        console.error(`[ERROR] OpenAI API call failed: ${error.message}`);
        return "❌ Failed to get a response. Please try again.";
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
        } else if (body.startsWith("expense summary for ")) {
            const jobMatch = body.match(/expense summary for (.+)/i);
            reply = jobMatch ? await getJobExpenseSummary(from, jobMatch[1].trim()) : "⚠️ Please specify a job name.";
        } else {
            const activeJob = await getActiveJob(from) || "Uncategorized";

            const expenseData = parseExpenseMessage(body);
            if (expenseData) {
                await appendToUserSpreadsheet(
                    from,
                    [expenseData.date, expenseData.item, expenseData.amount, expenseData.store, activeJob]
                );
                reply = `✅ Expense logged under '${activeJob}': ${expenseData.item} for ${expenseData.amount} at ${expenseData.store} on ${expenseData.date}`;
            } else {
                reply = await getChatGPTResponse(body);
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
