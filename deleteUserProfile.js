// deleteUserProfile.js

require('dotenv').config();
const admin = require('firebase-admin');

// ─── FIREBASE ADMIN SETUP ────────────────────────────────────────────
if (!admin.apps.length) {
    const firebaseCredentialsBase64 = process.env.FIREBASE_CREDENTIALS_BASE64;

    if (!firebaseCredentialsBase64) {
        console.error("[ERROR] FIREBASE_CREDENTIALS_BASE64 is not set in environment variables.");
        process.exit(1);
    }

    try {
        const firebaseCredentials = JSON.parse(
            Buffer.from(firebaseCredentialsBase64, 'base64').toString('utf-8')
        );
        admin.initializeApp({
            credential: admin.credential.cert(firebaseCredentials),
        });
        console.log("[✅] Firebase Admin initialized successfully.");
    } catch (error) {
        console.error("[ERROR] Failed to initialize Firebase Admin:", error.message);
        process.exit(1);
    }
}

const db = admin.firestore();

/**
 * Deletes a user profile from Firestore by phone number.
 * 
 * @param {string} phoneNumber - The phone number of the user (in WhatsApp format, e.g., 'whatsapp:+1234567890').
 */
async function deleteUserProfile(phoneNumber) {
    try {
        const userRef = db.collection('users').doc(phoneNumber);
        const doc = await userRef.get();

        if (!doc.exists) {
            console.log(`[ℹ️] No user profile found for ${phoneNumber}`);
            return;
        }

        await userRef.delete();
        console.log(`[✅ SUCCESS] User profile for ${phoneNumber} has been deleted.`);
    } catch (error) {
        console.error(`[❌ ERROR] Failed to delete user profile for ${phoneNumber}:`, error.message);
    }
}

// ─── INPUT: Replace with your phone number ────────────────────────────
const phoneNumberToDelete = '+19053279955';

// Run the deletion
deleteUserProfile(phoneNumberToDelete);
