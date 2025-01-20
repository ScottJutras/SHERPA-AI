const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = process.env.FIREBASE_CREDENTIALS;

if (!serviceAccountPath) {
    throw new Error('[ERROR] FIREBASE_CREDENTIALS not set in environment variables.');
}

admin.initializeApp({
    credential: admin.credential.cert(require(path.join(__dirname, serviceAccountPath))),
});

const db = admin.firestore();

module.exports = db;
