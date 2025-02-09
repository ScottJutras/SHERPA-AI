const chrono = require('chrono-node');

function parseExpenseMessage(message) {
    console.log(`[DEBUG] Parsing expense message: "${message}"`);

    // Enhanced amount extraction
    const amountMatch = message.match(/(?:\$|for\s?|spent\s?)\s?([\d,]+(?:\.\d{1,2})?)/i);
    const amount = amountMatch
        ? `$${parseFloat(amountMatch[1].replace(/,/g, '')).toFixed(2)}`
        : null;

    // Store name extraction: Improved to capture full names like "Home Depot"
    const storeMatch = message.match(/(?:at|from)\s+([\w\s&'’-]+?)(?=\s|$|\.)/i);
    const store = storeMatch ? storeMatch[1].trim() : "Unknown Store";

    // Date extraction using chrono-node
    const parsedDate = chrono.parseDate(message);
    const date = parsedDate
        ? parsedDate.toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

    // Improved item extraction patterns
    let item = null;
    const patterns = [
        /(?:bought|purchased|got|spent on|paid for)\s+(?:\$?\d+(?:,\d{3})*(?:\.\d{1,2})?\s*(?:dollars)?\s*)?(?:worth of\s+)?([\w\d\s-]+?)(?=\s(?:at|from|\$|\d|today|yesterday|on))/i,
        /(?:just got|picked up|ordered)\s+([\w\d\s-]+?)(?=\s(?:for|at|from|\$|\d|today|yesterday))/i,
        /([\d]+x[\d]+(?:\s\w+)?)/i // e.g., "20 2x4"
    ];

    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match) {
            item = match[1].trim();
            break;
        }
    }

    // Fallback: Default to "Miscellaneous Purchase"
    if (!item) {
        item = "Miscellaneous Purchase";
    }

    // Remove redundant store mentions from item
    if (store !== "Unknown Store") {
        const regex = new RegExp(`\\bat\\s*${store}\\b`, 'gi');
        item = item.replace(regex, '').trim();
    }

    // Check for missing essential fields
    if (!amount || !store || !item) {
        console.log("[DEBUG] Missing essential data, returning null.");
        return null;
    }

    console.log(`[DEBUG] Parsed Expense Data: item="${item}", amount="${amount}", store="${store}", date="${date}"`);

    return {
        item,
        amount,
        store,
        date
    };
}

module.exports = { parseExpenseMessage };
