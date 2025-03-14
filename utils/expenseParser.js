// C:\Users\scott\Documents\Sherpa AI\utils\expenseParser.js
const OpenAI = require('openai');
const chrono = require('chrono-node');
const materialsList = require('./materialsList');
const toolsList = require('./toolsList');
const storeList = require('./storeList');
const allItemsList = [...materialsList, ...toolsList];

// All stores in storeList.js are construction-related
const constructionStores = storeList.map(store => store.toLowerCase());

async function parseExpenseMessage(message) {
    console.log(`[DEBUG] Parsing expense message with AI: "${message}"`);
    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    try {
        const prompt = `
            Extract structured expense data from the following message: "${message}".
            Return a JSON object with keys: 
            - date (ISO format, e.g., "2025-03-13", default to today if not specified)
            - item (the purchased item, e.g., "nails")
            - amount (in "$X.XX" format, e.g., "$50.00")
            - store (the store name, e.g., "Home Depot", default to "Unknown Store" if unclear)
            If any field is ambiguous or missing, infer it sensibly based on context.
            Examples:
            - "$50 for nails at home depot" → {"date": "2025-03-13", "item": "nails", "amount": "$50.00", "store": "Home Depot"}
            - "spent 50 on screws yesterday" → {"date": "2025-03-12", "item": "screws", "amount": "$50.00", "store": "Unknown Store"}
        `;

        const gptResponse = await openaiClient.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: prompt },
                { role: "user", content: message }
            ],
            max_tokens: 100,
            temperature: 0.3
        });

        let expenseData = JSON.parse(gptResponse.choices[0].message.content);

        // Normalize and validate
        expenseData.date = expenseData.date || new Date().toISOString().split('T')[0];
        expenseData.item = expenseData.item || "Miscellaneous Purchase";
        expenseData.amount = expenseData.amount ? `$${parseFloat(expenseData.amount.replace('$', '')).toFixed(2)}` : null;
        expenseData.store = expenseData.store || "Unknown Store";

        // Enhance with chrono-node for date if AI misses it
        const parsedDate = chrono.parseDate(message);
        if (parsedDate) {
            expenseData.date = parsedDate.toISOString().split('T')[0];
        }

        // Fallback store detection
        if (expenseData.store === "Unknown Store") {
            const foundStore = storeList.find(storeName => 
                message.toLowerCase().includes(storeName.toLowerCase())
            );
            expenseData.store = foundStore || "Unknown Store";
        }

        // Fallback item detection
        if (expenseData.item === "Miscellaneous Purchase") {
            const foundItem = allItemsList.find(listItem => 
                message.toLowerCase().includes(listItem.toLowerCase())
            );
            expenseData.item = foundItem || "Miscellaneous Purchase";
        }

        // Category inference
        expenseData.suggestedCategory = constructionStores.some(storeName => 
            expenseData.store.toLowerCase().includes(storeName)) 
            ? "Construction Materials" : "General";

        if (!expenseData.amount || !expenseData.item) {
            console.log("[DEBUG] AI parsing failed to extract essential data.");
            return null;
        }

        console.log(`[DEBUG] Parsed Expense Data: item="${expenseData.item}", amount="${expenseData.amount}", store="${expenseData.store}", date="${expenseData.date}", category="${expenseData.suggestedCategory}"`);
        return expenseData;
    } catch (error) {
        console.error("[ERROR] AI parsing failed:", error.message);
        return null;
    }
}

async function parseRevenueMessage(message) { // Added 'async' here
    console.log(`[DEBUG] Parsing revenue message with AI: "${message}"`);
    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    try {
        const prompt = `
            Extract structured revenue data from the following message: "${message}".
            Return a JSON object with keys:
            - date (ISO format, e.g., "2025-03-13", default to today if not specified)
            - amount (in "$X.XX" format, e.g., "$50.00")
            - source (the revenue source, e.g., "John Doe", default to "Unknown Client" if unclear)
            Example: "received $50 from John yesterday" → {"date": "2025-03-12", "amount": "$50.00", "source": "John"}
        `;

        const gptResponse = await openaiClient.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: prompt },
                { role: "user", content: message }
            ],
            max_tokens: 100,
            temperature: 0.3
        });

        let revenueData = JSON.parse(gptResponse.choices[0].message.content);

        // Normalize and validate
        revenueData.date = revenueData.date || new Date().toISOString().split('T')[0];
        revenueData.amount = revenueData.amount ? `$${parseFloat(revenueData.amount.replace('$', '')).toFixed(2)}` : null;
        revenueData.source = revenueData.source || "Unknown Client";

        // Enhance with chrono-node for date
        const parsedDate = chrono.parseDate(message);
        if (parsedDate) {
            revenueData.date = parsedDate.toISOString().split('T')[0];
        }

        if (!revenueData.amount) {
            console.log("[DEBUG] AI parsing failed to extract amount.");
            return null;
        }

        console.log(`[DEBUG] Parsed Revenue Data: amount="${revenueData.amount}", source="${revenueData.source}", date="${revenueData.date}"`);
        return revenueData;
    } catch (error) {
        console.error("[ERROR] AI parsing failed:", error.message);
        return null;
    }
}

module.exports = { parseExpenseMessage, parseRevenueMessage };