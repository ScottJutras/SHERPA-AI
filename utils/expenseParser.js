const chrono = require('chrono-node');
const materialsList = require('./materialsList');
const toolsList = require('./toolsList');
const storeList = require('./storeList');
const allItemsList = [...materialsList, ...toolsList];

function parseExpenseMessage(message) {
  console.log(`[DEBUG] Parsing expense message: "${message}"`);
  let expenseData;

  // Attempt to parse JSON if the message looks like JSON (e.g., from OCR)
  try {
    expenseData = JSON.parse(message);
    expenseData.amount = expenseData.amount ? `$${parseFloat(expenseData.amount).toFixed(2)}` : null;
    expenseData.date = expenseData.date || new Date().toISOString().split('T')[0];
    expenseData.item = expenseData.item || null;
    expenseData.store = expenseData.store || "Unknown Store";

    // Extract item from full OCR text if available
    if (!expenseData.item && expenseData.text) {
      const patterns = [
        /(?:bought|purchased|got|spent on|spend on|paid for|on)?\s*([\w\d\s"-]+?)\s*(?:\$|\d+\.\d{2})/i, // Match items before amount
        /([\d]+x[\d]+(?:\s\w+)?)/i, // e.g., "2x4 lumber"
        /(\d+\.\d+"\s*\w+)/i, // e.g., "4.5\" WOO"
        /(\w+\s*\d+\s*\w+)/i  // e.g., "MC 4.5\" 24T"
      ];

      for (const pattern of patterns) {
        const match = expenseData.text.match(pattern);
        if (match) {
          expenseData.item = match[1].trim();
          break;
        }
      }

      if (!expenseData.item) {
        const foundItem = allItemsList.find(listItem => 
          expenseData.text.toLowerCase().includes(listItem.toLowerCase())
        );
        expenseData.item = foundItem || "Miscellaneous Purchase";
      }
    } else if (!expenseData.item) {
      expenseData.item = "Miscellaneous Purchase";
    }

    // Suggested Category based on store
    let suggestedCategory = "General";
    if (expenseData.store.toLowerCase().includes("home depot") || expenseData.store.toLowerCase().includes("rona")) {
      suggestedCategory = "Construction Materials";
    } else if (expenseData.store.toLowerCase().includes("best buy")) {
      suggestedCategory = "Electronics";
    } else if (expenseData.store.toLowerCase().includes("canadian tire")) {
      suggestedCategory = "General Merchandise"; // Or "Tools and Hardware"
    } else if (expenseData.store.toLowerCase().includes("ikea")) {
      suggestedCategory = "Furniture";
    }
    expenseData.suggestedCategory = suggestedCategory;

    if (!expenseData.amount || !expenseData.store || !expenseData.item) {
      console.log("[DEBUG] Missing essential JSON data.");
    } else {
      console.log(`[DEBUG] Parsed JSON Expense Data: item="${expenseData.item}", amount="${expenseData.amount}", store="${expenseData.store}", date="${expenseData.date}", category="${expenseData.suggestedCategory}"`);
      return expenseData;
    }
  } catch (error) {
    console.log("[DEBUG] JSON parsing failed, using regex parsing:", error.message);
  }

  // Traditional text parsing logic if JSON parsing fails or lacks sufficient data
  const amountMatch = message.match(/(?:\$|for\s?|spent\s?|spend\s?|on\s?)\s?([\d,]+(?:\.\d{1,2})?)/i);
  const amount = amountMatch
    ? `$${parseFloat(amountMatch[1].replace(/,/g, '')).toFixed(2)}`
    : null;

  let storeMatch = message.match(/(?:at|from)\s+([\w\s&'’-]+?)(?=\s*(?:today|yesterday|on|$|\n|\.))|(?:at|from)\s+([\w\s&'’-]+?)(?:\s|$|\.)/i);
  let store = storeMatch ? (storeMatch[1] || storeMatch[2]).trim() : null;

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
    /(?:bought|purchased|got|spent on|spend on|paid for|on)?\s*([\w\d\s"-]+?)\s*(?:\$|\d+\.\d{2})/i,
    /([\d]+x[\d]+(?:\s\w+)?)/i,
    /(\d+\.\d+"\s*\w+)/i,
    /(\w+\s*\d+\s*\w+)/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      item = match[1].trim();
      break;
    }
  }

  if (!item || item === "Miscellaneous Purchase") {
    const foundItem = allItemsList.find(listItem => 
      message.toLowerCase().includes(listItem.toLowerCase())
    );
    item = foundItem ? foundItem : "Miscellaneous Purchase";
  }

  if (store !== "Unknown Store") {
    const regex = new RegExp(`\\bat\\s*${store}\\b`, 'gi');
    item = item.replace(regex, '').trim();
  }

  if (!amount) console.log("[DEBUG] Amount not detected.");
  if (!store || store === "Unknown Store") console.log("[DEBUG] Store not detected.");
  if (!item || item === "Miscellaneous Purchase") console.log("[DEBUG] Item not detected.");

  if (!amount || !store || !item) {
    console.log("[DEBUG] Missing essential data, returning null.");
    return null;
  }

  let suggestedCategory = "General";
  if (store.toLowerCase().includes("home depot") || store.toLowerCase().includes("rona")) {
    suggestedCategory = "Construction Materials";
  } else if (store.toLowerCase().includes("best buy")) {
    suggestedCategory = "Electronics";
  } else if (store.toLowerCase().includes("canadian tire")) {
    suggestedCategory = "General Merchandise";
  } else if (store.toLowerCase().includes("ikea")) {
    suggestedCategory = "Furniture";
  }

  console.log(`[DEBUG] Parsed Text Expense Data: item="${item}", amount="${amount}", store="${store}", date="${date}", category="${suggestedCategory}"`);

  return { item, amount, store, date, suggestedCategory };
}

function parseRevenueMessage(message) {
  console.log(`[DEBUG] Parsing revenue message: "${message}"`);
  const revenuePattern = /received\s*(\$?\d+(?:\.\d{2})?)\s*from\s*(.+)/i;
  const match = message.match(revenuePattern);

  if (match) {
    const amount = match[1].startsWith('$') ? match[1] : `$${match[1]}`;
    const source = match[2].trim();
    const date = new Date().toISOString().split('T')[0];
    console.log(`[DEBUG] Parsed Revenue Data: amount="${amount}", source="${source}", date="${date}"`);
    return { date, amount, source };
  }

  console.log("[DEBUG] Revenue parsing failed. No match found.");
  return null;
}

module.exports = { parseExpenseMessage, parseRevenueMessage };