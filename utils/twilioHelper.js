const axios = require('axios');
const { URLSearchParams } = require('url');

const sendTemplateMessage = async (to, contentSid, contentVariables = {}) => {
    try {
        if (!contentSid) {
            console.error("[ERROR] Missing ContentSid for Twilio template message.");
            return false;
        }
        const toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
        const formattedVariables = JSON.stringify(
            Array.isArray(contentVariables)
                ? contentVariables.reduce((acc, item, index) => {
                      acc[index + 1] = item.text;
                      return acc;
                  }, {})
                : contentVariables
        );
        console.log("[DEBUG] Sending Twilio template message with:", {
            To: toNumber,
            ContentSid: contentSid,
            ContentVariables: formattedVariables
        });
        const response = await axios.post(
            `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
            new URLSearchParams({
                From: process.env.TWILIO_WHATSAPP_NUMBER,
                To: toNumber,
                MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
                ContentSid: contentSid,
                ContentVariables: formattedVariables
            }).toString(),
            {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                auth: {
                    username: process.env.TWILIO_ACCOUNT_SID,
                    password: process.env.TWILIO_AUTH_TOKEN
                }
            }
        );
        console.log(`[✅] Twilio template message sent successfully to ${toNumber} with ContentSid "${contentSid}"`);
        return true;
    } catch (error) {
        console.error("[ERROR] Twilio template message failed:", error.response?.data || error.message);
        return false;
    }
};

module.exports = { sendTemplateMessage };

