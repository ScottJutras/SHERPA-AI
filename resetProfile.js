const { deleteUserProfile } = require('./utils/database');

const userPhoneNumber = process.argv[2]; // Get phone number from command line

if (!userPhoneNumber) {
    console.error("⚠️ Please provide a WhatsApp phone number to delete. Example:");
    console.error("   node resetProfile.js whatsapp:+19053279955");
    process.exit(1);
}

async function resetProfile() {
    try {
        await deleteUserProfile(userPhoneNumber);
        console.log(`✅ User profile deleted for ${userPhoneNumber}`);
    } catch (error) {
        console.error("❌ Error deleting user profile:", error);
    }
}

resetProfile();
