function parseQuoteMessage(message) {
    // Example: "Quote for Job 75 Hampton: 10 windows, 10 window labour hours"
    const match = message.match(/quote for job\s+(.+?):\s*(.+)/i);
    if (!match) return null;
    
    const jobName = match[1].trim();
    const itemsText = match[2].trim();
    const items = itemsText.split(',').map(itemStr => {
      const parts = itemStr.trim().split(/\s+/);
      const quantity = parseInt(parts[0], 10);
      const itemName = parts.slice(1).join(' ');
      return { quantity, item: itemName };
    });
    return { jobName, items };
  }
  
  function buildQuoteDetails(items, pricingData) {
    const quoteItems = [];
    let total = 0;
    items.forEach(({ quantity, item }) => {
      const unitPrice = pricingData[item.toLowerCase()] || 0;
      const itemTotal = unitPrice * quantity;
      total += itemTotal;
      quoteItems.push({
        item,
        quantity,
        unitPrice,
        itemTotal
      });
    });
    return { quoteItems, total };
  }
  
  module.exports = { parseQuoteMessage, buildQuoteDetails };
  