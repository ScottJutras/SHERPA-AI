const chrono = require('chrono-node');

function parseExpenseMessage(message) {
    console.log(`[DEBUG] Parsing expense message: "${message}"`);

    // **Extract amount**
    const amountMatch = message.match(/\$([\d,]+(?:\.\d{1,2})?)/);
    const amount = amountMatch ? `$${amountMatch[1]}` : null;

    // **Extract store name**
    let storeMatch = message.match(/(?:at|from)\s([\w\s&-]+?)(?:\s(today|yesterday|last\s\w+|on\s\w+))?(?:\.$|$)/i);
    let store = storeMatch ? storeMatch[1].trim() : null;

    // **Extract date using chrono-node**
    const parsedDate = chrono.parseDate(message);
    const date = parsedDate ? parsedDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    // **Extract item description**
    let item = null;
    const patterns = [
        /(?:got|bought|spent|paid|purchased)\s(.*?)\s(?:for\s)?\$\d+/i,  // "Bought a coffee for $5"
        /spent\s\$\d+\son\s(.*?)(?:\sfrom|\sat|$)/i,                      // "Spent $150 on a new chair from Ikea"
        /(?:just got|picked up|purchased)\s\$[\d,]+(?:\sof|\son)?\s([\w\s&-]+)/i, // "Just got $10 of 2x4"
        /(?:paid|spent|got)\s(?:\$[\d,]+\s)?(.*?)(?:\sat|from|on|for|$)/i, // "Paid $50 for gas at Shell"
        /(?:for|on)\s([\w\s&-]+?)\s?(?:at|from|$)/i, // "Paid $50 for gas at Shell"
        /(?:bought|picked up)\s([\w\s&-]+?)(?:\sfrom|\sat|$)/i, // "Bought screws from Home Depot"
    ];

    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match) {
            item = match[1].trim();
            break;
        }
    }

    // **Explicit keyword detection for common construction materials**
    const materialKeywords = [
        "lumber", "wood", "2x4", "plywood", "screws", "nails", "cement", "gravel", "drywall",
        "paint", "primer", "tiles", "shingles", "gutters", "insulation", "concrete", "sand",
        "flooring", "adhesive", "sealant", "tape", "bricks", "mortar", "plumbing", "electrical", "wire"
    ];

    if (!item) {
        const materialMatch = message.match(new RegExp(`\\b(${materialKeywords.join("|")})\\b`, "i"));
        if (materialMatch) {
            item = materialMatch[1];
        }
    }

    // **Clean extracted data**
    if (item) {
        item = item.replace(/\b(a|an|some|worth of)\b\s*/gi, "").trim();
        item = item.replace(/\b(today|yesterday|last\s\w+|on\s\w+)\b/i, "").trim();
        if (store) {
            item = item.replace(new RegExp(`\\bat\\s*${store}\\b`, 'gi'), "").trim();
        }
    }

    if (store) {
        store = store.replace(/\b(today|yesterday|last\s\w+|on\s\w+)\b/i, "").trim();
    }

    // **Ensure valid data before returning**
    if (!amount || !store || !item) {
        console.log("[DEBUG] Missing essential data, returning null.");
        return null;
    }

    return {
        item: item || "Unknown Item",
        amount,
        store,
        date
    };
}

module.exports = { parseExpenseMessage };
