const { parseExpenseMessage } = require('./utils/expenseParser');

// Test cases
const testMessages = [
    "Just got $10 of 2x4 at Home Depot today",
    "Bought a coffee for $5 at Starbucks yesterday",
    "Spent $150 on a new chair from Ikea last Monday",
    "Paid $50 for gas at Shell",
    "Got $25 worth of groceries from Walmart last Sunday",
];

console.log("\n🔍 Testing Expense Parser...\n");
testMessages.forEach((message) => {
    console.log(`📩 Message: "${message}"`);
    const parsed = parseExpenseMessage(message);
    console.log("✅ Parsed:", JSON.stringify(parsed, null, 2)); // Enforces multiline formatting
    console.log("------------------------------------------------------");
});

