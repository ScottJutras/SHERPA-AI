const twilio = require('twilio');

// Twilio credentials
const accountSid = 'Your-account-sid'; 
const authToken = 'Your-auth-key'; 
const client = twilio(accountSid, authToken);

// Send a WhatsApp message
client.messages
  .create({
    body: 'Hello from Twilio WhatsApp!',
    from: 'whatsapp:+14155238886',
    to: 'whatsapp:+19053279955',
  })
  .then((message) => console.log(`Message sent: ${message.sid}`))
  .catch((error) => console.error('Error sending message:', error));
