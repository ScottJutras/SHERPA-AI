require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ✅ Debug Twilio Environment Variables
console.log("[DEBUG] Twilio API URL:", `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`);
console.log("[DEBUG] TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID ? "Loaded" : "MISSING");
console.log("[DEBUG] TWILIO_AUTH_TOKEN:", process.env.TWILIO_AUTH_TOKEN ? "Loaded" : "MISSING");
console.log("[DEBUG] TWILIO_WHATSAPP_NUMBER:", process.env.TWILIO_WHATSAPP_NUMBER ? "Loaded" : "MISSING");
console.log("[DEBUG] TWILIO_MESSAGING_SERVICE_SID:", process.env.TWILIO_MESSAGING_SERVICE_SID ? "Loaded" : "MISSING");

// ✅ Simple Home Route for Testing
app.get('/', (req, res) => {
    res.send('Hello, Vercel!');
});

// ✅ Twilio Webhook Route
app.post('/webhook', async (req, res) => {
    console.log("[DEBUG] Incoming Twilio Webhook:", req.body);

    const from = req.body.From;
    const body = req.body.Body?.trim();

    if (!from) {
        console.error("[ERROR] Missing 'From' field in webhook request.");
        return res.status(400).send("Bad Request: Missing 'From'.");
    }

    // ✅ Send Quick Reply (Test Twilio API Request)
    try {
        const response = await axios.post(
            `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
            new URLSearchParams({
                From: process.env.TWILIO_WHATSAPP_NUMBER,
                To: from,
                Body: "✅ Quick Reply Test: Did you mean $100 for materials? Reply Yes or No.",
                "PersistentAction": ["reply?text=Yes", "reply?text=No"].join(',')
            }).toString(),
            {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                auth: {
                    username: process.env.TWILIO_ACCOUNT_SID,
                    password: process.env.TWILIO_AUTH_TOKEN
                }
            }
        );

        console.log("[✅ SUCCESS] Twilio API Response:", response.data);
    } catch (error) {
        console.error("[ERROR] Failed to send Quick Reply:", error.response?.data || error.message);
    }

    return res.send(`<Response><Message>✅ Webhook received.</Message></Response>`);
});

// ✅ Start Express Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
});
