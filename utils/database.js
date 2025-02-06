const admin = require('firebase-admin');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf8'))),
    });
}

const db = admin.firestore();

async function getUserProfile(userId) {
    const doc = await db.collection('users').doc(userId).get();
    return doc.exists ? doc.data() : null;
}

async function deleteUserProfile(userId) {
    await db.collection('users').doc(userId).delete();
    console.log(`✅ User profile deleted: ${userId}`);
}

module.exports = { getUserProfile, deleteUserProfile };
