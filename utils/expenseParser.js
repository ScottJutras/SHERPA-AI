const chrono = require('chrono-node');

function parseExpenseMessage(message) {
  console.log(`[DEBUG] Parsing expense message: "${message}"`);

  // Extract amount (Supports "$24.60", "24.60", "1,200.00")
  const amountMatch = message.match(/(?:\$|for\s?)\s?([\d,]+(?:\.\d{1,2})?)/i);
  const amount = amountMatch
    ? `$${parseFloat(amountMatch[1].replace(/,/g, '')).toFixed(2)}`
    : null;

  // Extract store name: try to capture words following "at" or "from"
  let storeMatch = message.match(/(?:at|from)\s+([\w\s&-]+?)(?:\s(?:today|yesterday|last\s\w+|on\s\w+))?(?:\.|$)/i);
  let store = storeMatch ? storeMatch[1].trim() : null;

  // Extract date using chrono-node; prefer explicit dates in the text.
  const parsedDate = chrono.parseDate(message);
  const date = parsedDate
    ? parsedDate.toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  // Extract item name by looking for phrases like "bought", "purchased", "spent on", etc.
  let item = null;
  const patterns = [
    /(?:bought|purchased|got|spent on|paid for)\s+([\w\d\s-]+?)(?=\s(?:for|at|from|\$|\d))/i,
    /(?:just got|picked up|ordered)\s+([\w\d\s-]+?)(?=\s(?:for|at|from|\$|\d))/i,
    /([\d]+x[\d]+(?:\s\w+)?)/i // e.g., "20 2x4"
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      item = match[1].trim();
      break;
    }
  }
  
  // Fallback: if no item is found, default to "Miscellaneous Purchase"
  if (!item) {
    item = "Miscellaneous Purchase";
  }

  // Final cleaning: remove any extraneous words from the item if store is mentioned
  if (store) {
    const regex = new RegExp(`\\bat\\s*${store}\\b`, 'gi');
    item = item.replace(regex, '').trim();
  }

  // Ensure all required fields exist
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
