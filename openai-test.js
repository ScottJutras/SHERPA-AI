require('dotenv').config(); // Load environment variables

const { OpenAI } = require('openai'); // Import the OpenAI class

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // Ensure this is set in your .env file
});

(async () => {
    try {
        // Create a completion using the ChatGPT model
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo', // Adjust the model as per your needs
            messages: [{ role: 'user', content: 'Hello, world!' }],
        });

        console.log('ChatGPT response:', response.choices[0].message.content.trim());
    } catch (error) {
        console.error('OpenAI Error:', error);
    }
})();


