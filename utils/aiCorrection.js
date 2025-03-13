const OpenAI = require('openai');
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function suggestCorrections(data, errors, originalMessage, type = 'expense') {
    try {
        const prompt = `
            The following ${type} entry has errors: ${JSON.stringify(data)}
            Detected errors: ${JSON.stringify(errors)}
            Original message: "${originalMessage}"
            Suggest corrections for each error based on the original message and common sense for a construction business.
            Return a JSON object with corrected fields (e.g., { amount: "$50.00", store: "Home Depot" } for expense, or { amount: "$1000.00", client: "John Doe" } for revenue).
        `;
        const response = await openaiClient.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "system", content: prompt }],
            max_tokens: 100,
            temperature: 0.3
        });
        const corrections = JSON.parse(response.choices[0].message.content.trim());
        return { corrections, tokensUsed: response.usage.total_tokens };
    } catch (error) {
        console.error(`[ERROR] AI correction failed for ${type}:`, error.message);
        return { corrections: null, tokensUsed: 0 };
    }
}

module.exports = { suggestCorrections };