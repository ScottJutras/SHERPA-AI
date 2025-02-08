const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.applicationDefault()
    });
}

const db = admin.firestore();
const phoneNumber = "whatsapp:+19053279955"; // Replace with your number

async function deleteUserProfile() {
    try {
        const userRef = db.collection('users').doc(phoneNumber);
        const doc = await userRef.get();

        if (doc.exists) {
            await userRef.delete();
            console.log(`[✅] Successfully deleted user: ${phoneNumber}`);
        } else {
            console.log(`[ℹ️] User not found: ${phoneNumber}`);
        }
    } catch (error) {
        console.error("[❌] Error deleting user profile:", error);
    }
}

deleteUserProfile();
