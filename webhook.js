require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const bodyParser = require('body-parser');
const { parseExpenseMessage } = require('./utils/expenseParser'); // Helper for expense parsing
const { appendToUserSpreadsheet, getOrCreateUserSpreadsheet } = require('./utils/googleSheets'); // Google Sheets integration
const admin = require('firebase-admin');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ✅ Load Google Credentials from Base64
let googleCredentials;
if (process.env.GOOGLE_CREDENTIALS_BASE64) {
    try {
        googleCredentials = JSON.parse(
            Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
        );
        console.log("[DEBUG] Successfully loaded Google Credentials from Base64.");
    } catch (error) {
        console.error("[ERROR] Failed to decode GOOGLE_CREDENTIALS_BASE64:", error.message);
        process.exit(1);
    }
} else {
    console.error("[ERROR] GOOGLE_CREDENTIALS_BASE64 is not set in environment variables.");
    process.exit(1);
}

// ✅ Initialize Firebase Admin SDK
if (!admin.apps.length) {
    const firebaseCredentialsBase64 = process.env.FIREBASE_CREDENTIALS_BASE64;
    if (!firebaseCredentialsBase64) {
        console.error("[ERROR] FIREBASE_CREDENTIALS_BASE64 is not set in environment variables.");
        process.exit(1);
    }

    try {
        const firebaseCredentials = JSON.parse(
            Buffer.from(firebaseCredentialsBase64, 'base64').toString('utf-8')
        );

        admin.initializeApp({
            credential: admin.credential.cert(firebaseCredentials),
        });

        console.log("[DEBUG] Firebase Admin initialized successfully.");
    } catch (error) {
        console.error("[ERROR] Failed to initialize Firebase Admin:", error.message);
        process.exit(1);
    }
}

const db = admin.firestore();

// ✅ Validate required environment variables
console.log('[DEBUG] OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'Loaded' : 'Missing');

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Determine the environment (production or development)
const environment = process.env.NODE_ENV || 'development';
console.log(`[DEBUG] Environment: ${environment}`);

// Function to get a response from ChatGPT
async function getChatGPTResponse(prompt) {
    if (!prompt || prompt.trim() === '') {
        console.error('[DEBUG] Invalid prompt: Prompt is empty or undefined.');
        throw new Error('Prompt is empty or undefined');
    }

    console.log(`[DEBUG] Sending prompt to OpenAI: ${prompt}`);

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

        console.log(`[DEBUG] OpenAI API response: ${JSON.stringify(response.data)}`);

        if (response.choices && response.choices.length > 0) {
            return response.choices[0].message.content.trim();
        } else {
            console.error('[DEBUG] OpenAI API response is empty or invalid.');
            throw new Error('OpenAI API response is empty or invalid');
        }
    } catch (error) {
        console.error(`[ERROR] OpenAI API call failed: ${error.message}`);
        throw new Error('Failed to fetch response from ChatGPT');
    }
}

// Webhook to handle incoming messages
app.post('/webhook', async (req, res) => {
    const from = req.body.From; // User's phone number
    const body = req.body.Body?.trim(); // User message as-is

    console.log(`[DEBUG] Incoming POST request to /webhook`);
    console.log(`[${environment}] Incoming message from ${from}: "${body}"`);

    let reply;

    try {
        // ✅ Check if the message is an expense log
        const expenseData = parseExpenseMessage(body);

        if (expenseData) {
            console.log(`[DEBUG] Parsed Expense Data:`, expenseData);

            try {
                // ✅ Retrieve or create the user's spreadsheet using their phone number
                const spreadsheetId = await getOrCreateUserSpreadsheet(from);
                if (!spreadsheetId) {
                    throw new Error("No spreadsheet ID found or created.");
                }

                // ✅ Append data to the user's spreadsheet
                await appendToUserSpreadsheet(
                    [expenseData.date, expenseData.item, expenseData.amount, expenseData.store],
                    spreadsheetId
                );

                reply = `Expense logged successfully: ${expenseData.item} for ${expenseData.amount} at ${expenseData.store} on ${expenseData.date}`;
                console.log(`[DEBUG] Expense logged reply: "${reply}"`);
            } catch (error) {
                console.error('[ERROR] Failed to log expense to Google Sheets:', error.message);
                reply = 'Failed to log your expense. Please try again later.';
            }
        } else if (body.toLowerCase() === 'hi' || body.toLowerCase() === 'hello') {
            reply = 'Hi! Welcome to our service. Reply with:\n1. Help\n2. Services\n3. Contact\n4. Log an Expense';
            console.log(`[DEBUG] Predefined reply for greeting: "${reply}"`);
        } else if (body === '1') {
            reply = 'How can we assist you today?';
            console.log(`[DEBUG] Predefined reply for Help: "${reply}"`);
        } else if (body === '2') {
            reply = 'We offer the following services:\n- Service 1\n- Service 2\n- Service 3';
            console.log(`[DEBUG] Predefined reply for Services: "${reply}"`);
        } else if (body === '3') {
            reply = 'You can reach us at support@example.com or call us at +1 234 567 890.';
            console.log(`[DEBUG] Predefined reply for Contact: "${reply}"`);
        } else {
            console.log(`[DEBUG] Custom input detected, querying ChatGPT...`);
            reply = await getChatGPTResponse(body);
            console.log(`[DEBUG] Reply from ChatGPT: "${reply}"`);
        }
    } catch (error) {
        console.error(`[ERROR] Error handling message from ${from}:`, error);
        reply = 'Sorry, something went wrong. Please try again later.';
    }

    // ✅ Send Twilio-compatible XML response
    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
    console.log(`[DEBUG] Reply sent: "${reply}"`);
});

// Handle GET requests to the root URL
app.get('/', (req, res) => {
    console.log(`[DEBUG] GET request to root URL`);
    res.send('Webhook server is up and running!');
});

// ✅ Start the server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`[${environment}] Webhook server is running on http://localhost:${PORT}`);
});

module.exports = app;
