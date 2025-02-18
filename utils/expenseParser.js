const chrono = require('chrono-node');
const materialsList = require('./materialsList');
const toolsList = require('./toolsList');
const storeList = require('./storeList');
const allItemsList = [...materialsList, ...toolsList];

function parseExpenseMessage(message) {
  console.log(`[DEBUG] Parsing expense message: "${message}"`);
  let expenseData;

  // Attempt to parse JSON if the message looks like JSON
  try {
    expenseData = JSON.parse(message);
    // If JSON parsing was successful, we directly use this data but add or adjust fields if necessary
    expenseData.amount = expenseData.amount ? `$${parseFloat(expenseData.amount).toFixed(2)}` : null;
    expenseData.date = expenseData.date || new Date().toISOString().split('T')[0];
    expenseData.item = expenseData.item || "Miscellaneous Purchase";
    expenseData.store = expenseData.store || "Unknown Store";

    // If JSON data doesn't contain all necessary fields, log and adjust
    if (!expenseData.amount) console.log("[DEBUG] Amount not detected from JSON.");
    if (!expenseData.store || expenseData.store === "Unknown Store") console.log("[DEBUG] Store not detected from JSON.");
    if (!expenseData.item || expenseData.item === "Miscellaneous Purchase") console.log("[DEBUG] Item not detected from JSON.");

    // Suggested Category for Dynamic Quick Replies
    let suggestedCategory = "General";
    if (expenseData.store.toLowerCase().includes("home depot") || expenseData.store.toLowerCase().includes("rona")) {
      suggestedCategory = "Construction Materials";
    } else if (expenseData.store.toLowerCase().includes("best buy")) {
      suggestedCategory = "Electronics";
    } else if (expenseData.store.toLowerCase().includes("ikea")) {
      suggestedCategory = "Furniture";
    }

    expenseData.suggestedCategory = suggestedCategory;
    console.log(`[DEBUG] Parsed JSON Expense Data: item="${expenseData.item}", amount="${expenseData.amount}", store="${expenseData.store}", date="${expenseData.date}", category="${expenseData.suggestedCategory}"`);
    return expenseData;
  } catch (error) {
    // JSON parsing failed, so we'll use the existing regex-based parsing
    console.log("[DEBUG] JSON parsing failed, using regex parsing...");
  }

  // Traditional text parsing logic if JSON parsing fails
  const amountMatch = message.match(/(?:\$|for\s?|spent\s?|spend\s?|on\s?)\s?([\d,]+(?:\.\d{1,2})?)/i);
  const amount = amountMatch
    ? `$${parseFloat(amountMatch[1].replace(/,/g, '')).toFixed(2)}`
    : null;

  let storeMatch = message.match(/(?:at|from)\s+([\w\s&'’-]+?)(?=\s*(?:today|yesterday|on|$|\n|\.))|(?:at|from)\s+([\w\s&'’-]+?)(?:\s|$|\.)/i);
  let store = storeMatch ? (storeMatch[1] || storeMatch[2]).trim() : null;

  // Check against predefined store list if regex fails
  if (!store || store === "Unknown Store") {
    const foundStore = storeList.find(storeName => 
      message.toLowerCase().includes(storeName.toLowerCase())
    );
    store = foundStore ? foundStore : "Unknown Store";
  }

  const parsedDate = chrono.parseDate(message);
  const date = parsedDate
    ? parsedDate.toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  let item = null;
  const patterns = [
    /(?:bought|purchased|got|spent on|spend on|paid for|on)\s+(?:\d+\s*(?:dollars)?\s*)?(?:worth of\s+)?([\w\d\s-]+?)(?=\s(?:at|from|\$|\d|today|yesterday|on|for|\.|$))/i,
    /(?:just got|picked up|ordered)\s+([\w\d\s-]+?)(?=\s(?:for|at|from|\$|\d|today|yesterday|on|\.|$))/i,
    /([\d]+x[\d]+(?:\s\w+)?)/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      item = match[1].trim();
      break;
    }
  }

  // Fallback: Use materials/tools lists if regex patterns didn't capture a specific item
  if (!item || item === "Miscellaneous Purchase") {
    const foundItem = allItemsList.find(listItem => 
      message.toLowerCase().includes(listItem.toLowerCase())
    );
    if (foundItem) {
      item = foundItem;
    } else {
      item = "Miscellaneous Purchase"; // Default fallback if nothing matches
    }
  }

  // Final cleaning: remove redundant store mentions from item
  if (store !== "Unknown Store") {
    const regex = new RegExp(`\\bat\\s*${store}\\b`, 'gi');
    item = item.replace(regex, '').trim();
  }

  // Error Handling: Log missing fields for debugging
  if (!amount) console.log("[DEBUG] Amount not detected.");
  if (!store || store === "Unknown Store") console.log("[DEBUG] Store not detected.");
  if (!item || item === "Miscellaneous Purchase") console.log("[DEBUG] Item not detected.");

  // Ensure all required fields exist
  if (!amount || !store || !item) {
    console.log("[DEBUG] Missing essential data, returning null.");
    return null;
  }

  // Suggested Category for Dynamic Quick Replies
  let suggestedCategory = "General";
  if (store.toLowerCase().includes("home depot") || store.toLowerCase().includes("rona")) {
    suggestedCategory = "Construction Materials";
  } else if (store.toLowerCase().includes("best buy")) {
    suggestedCategory = "Electronics";
  } else if (store.toLowerCase().includes("ikea")) {
    suggestedCategory = "Furniture";
  }

  console.log(`[DEBUG] Parsed Text Expense Data: item="${item}", amount="${amount}", store="${store}", date="${date}", category="${suggestedCategory}"`);

  return { item, amount, store, date, suggestedCategory };
}

// ─── ADD THIS FUNCTION FOR REVENUE PARSING ───
function parseRevenueMessage(message) {
  console.log(`[DEBUG] Parsing revenue message: "${message}"`);

  // Revenue pattern: Extracts phrases like "Received $500 from John"
  const revenuePattern = /received\s*(\$?\d+(?:\.\d{2})?)\s*from\s*(.+)/i;
  const match = message.match(revenuePattern);

  if (match) {
    const amount = match[1].startsWith('$') ? match[1] : `$${match[1]}`;
    const source = match[2].trim();
    const date = new Date().toISOString().split('T')[0]; // Current date
    console.log(`[DEBUG] Parsed Revenue Data: amount="${amount}", source="${source}", date="${date}"`);
    return { date, amount, source };
  }

  console.log("[DEBUG] Revenue parsing failed. No match found.");
  return null;
}

// ─── FIX EXPORT TO INCLUDE `parseRevenueMessage` ───
module.exports = { parseExpenseMessage, parseRevenueMessage };
