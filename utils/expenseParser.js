const chrono = require('chrono-node');

function parseExpenseMessage(message) {
    console.log(`[DEBUG] Parsing expense message: "${message}"`);

    // ✅ Extract amount (Recognizes numbers with or without `$`)
    const amountMatch = message.match(/(?:\$\s?|for\s?)?\s?([\d]{1,6}(?:\.\d{1,2})?)/i);
    const amount = amountMatch ? `$${amountMatch[1].trim()}` : null;

    // ✅ Extract store name
    let storeMatch = message.match(/(?:at|from)\s([\w\s&-]+?)(?:\s(today|yesterday|last\s\w+|on\s\w+))?(?:\.$|$)/i);
    let store = storeMatch ? storeMatch[1].trim() : null;

    // ✅ Extract date using chrono-node
    const parsedDate = chrono.parseDate(message);
    const date = parsedDate ? parsedDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    // ✅ Extract item name (Handles "2x4", "4x8 plywood", etc.)
    let item = null;

    const patterns = [
        /(?:bought|purchased|got|spent on|paid for)\s([\w\d\s-]+?)\s(?:for|at|from|\$|\d)/i, // "Bought 2x4 from Home Depot"
        /(?:just got|picked up|ordered)\s([\w\d\s-]+?)\s(?:for|at|from|\$|\d)/i,              // "Just got 10 bags of cement"
        /(?:spent\s[\d,]+(?:\.\d{1,2})?\son\s([\w\d\s-]+?)\s(?:at|from|on|for|$))/i,         // "Spent 50 on screws at Home Depot"
        /([\d]+x[\d]+(?:\s\w+)?)\s(?:for|at|from|\$|\d)/i                                    // "2x4 for $24.60"
    ];

    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match) {
            item = match[1].trim();
            break;
        }
    }

    // ✅ Handle construction materials like "2x4", "4x8 plywood"
    const materialKeywords = [
        "lumber", "wood", "2x4", "4x8", "plywood", "screws", "nails", "cement", "gravel", "drywall",
        "paint", "primer", "tiles", "shingles", "gutters", "insulation", "concrete", "sand",
        "flooring", "adhesive", "sealant", "tape", "bricks", "mortar", "plumbing", "electrical", "wire"
    ];

    if (!item) {
        const materialMatch = message.match(new RegExp(`\\b(${materialKeywords.join("|")})\\b`, "i"));
        if (materialMatch) {
            item = materialMatch[1];
        }
    }

    // ✅ Final cleaning
    if (item) {
        item = item.replace(/\b(a|an|some|worth of)\b\s*/gi, "").trim();
        if (store) {
            item = item.replace(new RegExp(`\\bat\\s*${store}\\b`, 'gi'), "").trim();
        }
    }

    if (store) {
        store = store.replace(/\b(today|yesterday|last\s\w+|on\s\w+)\b/i, "").trim();
    }

    // ✅ Validation: Ensure required fields are present
    if (!amount || !store || !item) {
        console.error("[DEBUG] Missing essential data, returning null.");
        return null;
    }

    console.log(`[DEBUG] Successfully parsed expense: Item: ${item}, Amount: ${amount}, Store: ${store}, Date: ${date}`);

    return {
        item: item || "Unknown Item",
        amount,
        store,
        date
    };
}

module.exports = { parseExpenseMessage };
