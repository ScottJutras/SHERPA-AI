const sendgrid = require('@sendgrid/mail');

// Set SendGrid API Key
sendgrid.setApiKey(process.env.SENDGRID_API_KEY);

/**
 * Sends an email with the user's spreadsheet link
 * @param {string} userEmail - The recipient's email
 * @param {string} spreadsheetId - The Google Sheet ID
 */
async function sendSpreadsheetEmail(userEmail, spreadsheetId) {
    if (!userEmail) {
        console.error("[ERROR] No email provided. Skipping email notification.");
        return;
    }

    const spreadsheetLink = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    const msg = {
        to: userEmail,
        from: 'your-email@example.com',  // Ensure this email is verified in SendGrid
        subject: 'Your Expense Spreadsheet is Ready!',
        html: `
            <p>Hello,</p>
            <p>Your expense tracking spreadsheet has been created. You can access it here:</p>
            <p><a href="${spreadsheetLink}">${spreadsheetLink}</a></p>
            <p>Happy tracking!</p>
        `,
    };

    try {
        await sendgrid.send(msg);
        console.log(`[✅] Spreadsheet email sent to ${userEmail}`);
    } catch (error) {
        console.error(`[ERROR] SendGrid Email Failed:`, error.response?.body || error);
    }
}

module.exports = { sendSpreadsheetEmail };
