require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json()); // Add JSON body parsing for flexibility

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // Ensure this is set in your .env file
});

// Function to get a response from ChatGPT
async function getChatGPTResponse(prompt) {
    try {
        const response = await openai.completions.create({
            model: 'text-davinci-003',
            prompt: prompt,
            max_tokens: 100,
            temperature: 0.7,
        });
        return response.choices[0].text.trim();
    } catch (error) {
        console.error('Error in OpenAI API call:', error.message);
        throw new Error('Failed to fetch response from ChatGPT');
    }
}

// GET route for testing deployment
app.get('/', (req, res) => {
    res.send('Webhook server is up and running!');
});

// Webhook to handle incoming messages
app.post('/webhook', async (req, res) => {
    const from = req.body.From; // User's phone number
    const body = req.body.Body?.trim().toLowerCase(); // Normalize input

    let reply;

    try {
        if (body === 'hi' || body === 'hello') {
            reply = 'Hi! Welcome to our service. Reply with:\n1. Help\n2. Services\n3. Contact';
        } else if (body === '1') {
            reply = 'How can we assist you today?';
        } else if (body === '2') {
            reply = 'We offer the following services:\n- Service 1\n- Service 2\n- Service 3';
        } else if (body === '3') {
            reply = 'You can reach us at support@example.com or call us at +1 234 567 890.';
        } else {
            // Fallback to ChatGPT for freeform input
            reply = await getChatGPTResponse(body);
        }
    } catch (error) {
        console.error('Error handling incoming message:', error);
        reply = 'Sorry, something went wrong. Please try again later.';
    }

    // Send Twilio-compatible XML response
    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
});

// Start the server
const PORT = process.env.PORT || 4000; // Use Vercel's PORT or default to 4000 for local development
app.listen(PORT, () => {
    console.log(`Webhook server is running on http://localhost:${PORT}`);
});

module.exports = app; // Export app for Vercel





