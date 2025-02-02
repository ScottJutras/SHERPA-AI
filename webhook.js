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
const admin = require('firebase-admin');

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

        const spreadsheetId = await getOrCreateUserSpreadsheet(from);
        if (!spreadsheetId) throw new Error("No spreadsheet ID found.");

        const expenseData = await fetchExpenseData(spreadsheetId, jobName);
        const analytics = calculateExpenseAnalytics(expenseData);

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
}

// ✅ Function to handle setting a new job
async function handleStartJob(from, body) {
    const jobMatch = body.match(/start job (.+)/i);
    if (!jobMatch) return "⚠️ Please specify a job name. Example: 'Start job 75 Hampton Crt'";

    const jobName = jobMatch[1].trim();
    await setActiveJob(from, jobName);
    
    return `✅ Job '${jobName}' is now active. All expenses will be assigned to this job.`;
}

// ✅ Function to get response from ChatGPT
async function getChatGPTResponse(prompt) {
    console.log(`[DEBUG] ChatGPT Request: "${prompt}"`);
    if (!prompt || prompt.trim() === '') {
        console.error("[ERROR] Invalid prompt: Empty or undefined.");
        throw new Error("Prompt is empty or undefined.");
    }

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: 'You are a helpful assistant.' },
                { role: 'user', content: prompt },
            ],
            max_tokens: 100,
            temperature: 0.7,
        });

        console.log(`[DEBUG] OpenAI API Response: ${JSON.stringify(response.data)}`);
        if (response.choices?.length > 0) {
            return response.choices[0].message.content.trim();
        } else {
            console.error("[ERROR] OpenAI response was empty.");
            throw new Error("OpenAI API response is empty.");
        }
    } catch (error) {
        console.error(`[ERROR] OpenAI API call failed: ${error.message}`);
        throw new Error("Failed to fetch response from ChatGPT.");
    }
}

// ✅ Webhook to handle incoming messages
app.post('/webhook', async (req, res) => {
    console.log("[DEBUG] Incoming Webhook Request", JSON.stringify(req.body));

    const from = req.body.From;
    const body = req.body.Body?.trim().toLowerCase();

    if (!from || !body) {
        console.error("[ERROR] Webhook request missing 'From' or 'Body'.");
        return res.status(400).send("Bad Request: Missing 'From' or 'Body'.");
    }

    console.log(`[DEBUG] Incoming message from ${from}: "${body}"`);
    let reply;

    try {
        if (body.startsWith("start job ")) {
            reply = await handleStartJob(from, body);
        } else if (body.startsWith("expense summary for ")) {
            const jobMatch = body.match(/expense summary for (.+)/i);
            if (!jobMatch) {
                reply = "⚠️ Please specify a job name. Example: 'Expense summary for 75 Hampton Crt'";
            } else {
                const jobName = jobMatch[1].trim();
                reply = await getJobExpenseSummary(from, jobName);
            }
        } else {
            const activeJob = await getActiveJob(from);
            const expenseData = parseExpenseMessage(body);

            if (expenseData) {
                console.log(`[DEBUG] Parsed Expense Data:`, expenseData);

                try {
                    const spreadsheetId = await getOrCreateUserSpreadsheet(from);
                    if (!spreadsheetId) throw new Error("No spreadsheet ID found.");

                    await appendToUserSpreadsheet(
                        [expenseData.date, expenseData.item, expenseData.amount, expenseData.store, activeJob || "Uncategorized"],
                        spreadsheetId
                    );

                    reply = `✅ Expense logged under '${activeJob || "Uncategorized"}': ${expenseData.item} for ${expenseData.amount} at ${expenseData.store} on ${expenseData.date}`;
                    console.log(`[DEBUG] Expense logged reply: "${reply}"`);
                } catch (error) {
                    console.error('[ERROR] Failed to log expense to Google Sheets:', error.message);
                    reply = "❌ Failed to log your expense. Please try again later.";
                }
            } else if (["hi", "hello"].includes(body)) {
                reply = "👋 Hi! Welcome to our service. Reply with:\n1️⃣ Help\n2️⃣ Services\n3️⃣ Contact\n4️⃣ Log an Expense\n5️⃣ Expense Summary";
            } else {
                console.log("[DEBUG] Custom input detected, querying ChatGPT...");
                reply = await getChatGPTResponse(body);
            }
        }
    } catch (error) {
        console.error(`[ERROR] Error handling message from ${from}:`, error);
        reply = "⚠️ Sorry, something went wrong. Please try again later.";
    }

    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
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
