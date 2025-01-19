function parseExpenseMessage(message) {
    // Regex patterns to extract data
    const itemPattern = /bought\s(.*?)\sfor/i; // Captures item after "bought" and before "for"
    const amountPattern = /\$([0-9,.]+)/; // Captures the dollar amount
    const storePattern = /from\s(.*?)(?:\son|\.$)/i; // Captures store name after "from" and before "on" or "."
    const datePattern = /on\s(.*)/i; // Captures date after "on"

    const itemMatch = message.match(itemPattern);
    const amountMatch = message.match(amountPattern);
    const storeMatch = message.match(storePattern);
    const dateMatch = message.match(datePattern);

    if (itemMatch && amountMatch && storeMatch && dateMatch) {
        return {
            item: itemMatch[1].trim(),
            amount: `$${amountMatch[1].trim()}`,
            store: storeMatch[1].trim(),
            date: dateMatch[1].trim(),
        };
    }

    // Return null if parsing fails
    return null;
}

module.exports = { parseExpenseMessage };
