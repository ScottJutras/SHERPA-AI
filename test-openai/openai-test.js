require('dotenv').config();
console.log("API Key:", process.env.OPENAI_API_KEY);

const { Configuration, OpenAIApi } = require('openai');

const configuration = new Configuration({
    apiKey: 'OPENAI_API_KEY', // Replace with your API key for testing
});

const openai = new OpenAIApi(configuration);

(async () => {
    try {
        const response = await openai.createCompletion({
            model: 'text-davinci-003',
            prompt: 'Hello!',
            max_tokens: 10,
        });
        console.log('OpenAI Response:', response.data.choices[0].text.trim());
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
})();
