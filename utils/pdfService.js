const PDFDocument = require('pdfkit');
const fs = require('fs');

function generateQuotePDF(quoteData, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    // Header
    doc.fontSize(20).text('Quote', { align: 'center' });
    doc.fontSize(12).text(`Job: ${quoteData.jobName}`, { align: 'left' });
    doc.text(`Date: ${new Date().toLocaleDateString()}`, { align: 'left' });
    doc.text(`Contractor: ${quoteData.contractorName}`, { align: 'left' });
    doc.text(`Customer: ${quoteData.customerName || 'N/A'}`, { align: 'left' });
    doc.moveDown();

    // Itemized List
    doc.fontSize(14).text('Itemized Breakdown', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);
    const tableTop = doc.y;
    const itemWidth = 200;
    const qtyWidth = 50;
    const priceWidth = 100;
    const totalWidth = 100;

    // Table Headers
    doc.text('Item', 50, tableTop);
    doc.text('Qty', 50 + itemWidth, tableTop, { width: qtyWidth, align: 'right' });
    doc.text('Unit Price', 50 + itemWidth + qtyWidth, tableTop, { width: priceWidth, align: 'right' });
    doc.text('Total', 50 + itemWidth + qtyWidth + priceWidth, tableTop, { width: totalWidth, align: 'right' });
    doc.moveDown(0.5);

    // Table Rows
    let yPos = doc.y;
    quoteData.items.forEach(({ item, quantity, price }) => {
      const lineTotal = quantity * price;
      doc.text(item, 50, yPos);
      doc.text(quantity.toString(), 50 + itemWidth, yPos, { width: qtyWidth, align: 'right' });
      doc.text(`$${price.toFixed(2)}`, 50 + itemWidth + qtyWidth, yPos, { width: priceWidth, align: 'right' });
      doc.text(`$${lineTotal.toFixed(2)}`, 50 + itemWidth + qtyWidth + priceWidth, yPos, { width: totalWidth, align: 'right' });
      yPos += 20;
    });

    // Financial Summary
    doc.moveDown(1);
    doc.fontSize(12);
    doc.text(`Subtotal: $${quoteData.subtotal.toFixed(2)}`, { align: 'right' });
    doc.text(`Tax (13%): $${quoteData.tax.toFixed(2)}`, { align: 'right' });
    doc.text(`Total (with 20% markup): $${quoteData.total.toFixed(2)}`, { align: 'right' });

    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

module.exports = { generateQuotePDF };