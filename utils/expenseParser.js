const chrono = require('chrono-node');

function parseExpenseMessage(message) {
  console.log(`[DEBUG] Parsing expense message: "${message}"`);

  // Enhanced amount extraction: supports "$24.60", "24.60", "4872 dollars", "bought 4872"
  const amountMatch = message.match(/(?:\$|for\s?|bought\s?)?\s?([\d,]+(?:\.\d{1,2})?)\s?(?:dollars)?/i);
  const amount = amountMatch
    ? `$${parseFloat(amountMatch[1].replace(/,/g, '')).toFixed(2)}`
    : null;

  // Store name extraction: supports apostrophes in names like "Herman's Supply"
  let storeMatch = message.match(/(?:at|from)\s+([\w\s&'-]+?)(?:\s(?:today|yesterday|last\s\w+|on\s\w+))?(?:\.|$)/i);
  let store = storeMatch ? storeMatch[1].trim() : "Unknown Store";

  // Date extraction using chrono-node; defaults to today if not specified
  const parsedDate = chrono.parseDate(message);
  const date = parsedDate
    ? parsedDate.toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  // Item extraction: adjusts for "worth of" phrasing
  let item = null;
  const patterns = [
    /(?:bought|purchased|got|spent on|paid for)\s+(\d+\s*)?(?:dollars\s+)?(?:worth of\s+)?([\w\d\s-]+?)(?=\s(?:for|at|from|\$|\d|today|yesterday))/i,
    /(?:just got|picked up|ordered)\s+([\w\d\s-]+?)(?=\s(?:for|at|from|\$|\d|today|yesterday))/i,
    /([\d]+x[\d]+(?:\s\w+)?)/i // e.g., "20 2x4"
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      item = match[2] ? match[2].trim() : match[1].trim();
      break;
    }
  }

  // Fallback: if no item is found, default to "Miscellaneous Purchase"
  if (!item) {
    item = "Miscellaneous Purchase";
  }

  // Final cleaning: remove redundant store mentions from item name
  if (store !== "Unknown Store") {
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
