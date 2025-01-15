require('dotenv').config();
const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // Make sure .env contains this key
});

async function testOpenAI() {
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo', // Updated model
            messages: [{ role: 'user', content: 'Hello, how are you?' }], // Chat completion format
            max_tokens: 100,
            temperature: 0.7,
        });
        console.log('ChatGPT Response:', response.choices[0].message.content.trim());
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testOpenAI();



