const sgMail = require("@sendgrid/mail");

// Load SendGrid API Key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/**
 * Sends an email with the spreadsheet link to the user.
 * @param {string} userEmail - The recipient's email.
 * @param {string} spreadsheetId - The ID of the created Google Spreadsheet.
 */
async function sendSpreadsheetEmail(userEmail, spreadsheetId) {
  if (!userEmail) {
    console.error("[ERROR] No email provided. Cannot send spreadsheet email.");
    return;
  }

  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

  const msg = {
    to: userEmail,
    from: "scott@scottjutras.com", // Must match your verified sender email
    subject: "Your Expense Tracking Spreadsheet is Ready!",
    text: `Hello,\n\nYour expense tracking spreadsheet has been created. You can access it here: ${spreadsheetUrl}.\n\nBest,\nSherpAi Team`,
    html: `
      <p>Hello,</p>
      <p>Your expense tracking spreadsheet has been created.</p>
      <p><strong><a href="${spreadsheetUrl}" target="_blank">Click here to access it</a></strong></p>
      <p>Best,<br>SherpAi Team</p>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`[✅ SUCCESS] Spreadsheet email sent to ${userEmail}`);
  } catch (error) {
    console.error("[ERROR] SendGrid Email Failed:", error.response?.body || error.message);
  }
}

module.exports = { sendSpreadsheetEmail };
