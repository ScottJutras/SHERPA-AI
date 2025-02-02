const chrono = require('chrono-node');

function parseExpenseMessage(message) {
    const lowerMessage = message.toLowerCase();

    // ✅ Extract Date (e.g., "today", "yesterday", "Jan 5", "last Friday")
    let dateMatch = chrono.parseDate(lowerMessage);
    let formattedDate = dateMatch ? dateMatch.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    // ✅ Extract Price (supports "$10", "10 dollars", "CAD 15.50", etc.)
    const priceRegex = /(?:\$|cad\s*|usd\s*)?(\d+(?:\.\d{1,2})?)(?:\s*(?:dollars|bucks|cad|usd))?/i;
    const priceMatch = message.match(priceRegex);
    let price = priceMatch ? `$${parseFloat(priceMatch[1]).toFixed(2)}` : null;

    // ✅ Extract Store Name (assumes "at [Store]" format)
    const storeRegex = /at\s+([\w\s&-]+)/i;
    const storeMatch = message.match(storeRegex);
    let store = storeMatch ? storeMatch[1].trim() : "Unknown Store";

    // ✅ Extract Item Name (flexible pattern, assumes "[price] of [item] at [store]")
    let item = "Unknown Item";
    const itemRegex = /(?:got|bought|purchased|spent)\s+\$?\d+(?:\.\d{1,2})?\s+of\s+([\w\s\d&-]+)/i;
    const itemMatch = message.match(itemRegex);
    if (itemMatch) {
        item = itemMatch[1].trim();
    } else {
        // If "of [item]" isn't used, assume any noun phrase before "at [store]"
        const beforeStore = message.split(" at ")[0];
        const words = beforeStore.split(" ");
        for (let i = words.length - 1; i >= 0; i--) {
            if (!words[i].match(/\d+|\$/)) {
                item = words.slice(i).join(" ");
                break;
            }
        }
    }

    return { date: formattedDate, item, amount: price, store };
}

// ✅ Example Test Cases
const testMessages = [
    "just got $10 of 2x4 at Home Depot today",
    "Bought 5 gallons of paint at Sherwin Williams for $120 yesterday",
    "Spent $50 on tools at Lowe’s last Friday",
    "CAD 15 on screws at Canadian Tire",
    "got a hammer at Walmart for 25 dollars",
    "bought nails for $5",
];

testMessages.forEach(msg => {
    console.log(`📩 Message: "${msg}"`);
    console.log("🔍 Parsed Data:", parseExpenseMessage(msg));
    console.log("--------------------------------------------------");
});

module.exports = { parseExpenseMessage };
