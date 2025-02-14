async function mergeUserProfiles(phoneNumber) {
    try {
        const cleanNumber = phoneNumber.replace(/\D/g, ""); // Normalize number format
        const whatsappFormat = `whatsapp:+${cleanNumber}`;

        const cleanDocRef = db.collection('users').doc(cleanNumber);
        const whatsappDocRef = db.collection('users').doc(whatsappFormat);

        const cleanDoc = await cleanDocRef.get();
        const whatsappDoc = await whatsappDocRef.get();

        if (!whatsappDoc.exists) {
            console.log(`[✅] No need to merge. Keeping single profile: ${cleanNumber}`);
            return;
        }

        const cleanData = cleanDoc.exists ? cleanDoc.data() : {};
        const whatsappData = whatsappDoc.data();

        // ✅ Merge data (Firebase overwrites only missing values)
        const mergedData = { ...whatsappData, ...cleanData };

        // ✅ Save merged data in the preferred format
        await cleanDocRef.set(mergedData, { merge: true });
        console.log(`[✅ SUCCESS] Merged user profiles under ${cleanNumber}`);

        // ✅ Delete the old Twilio format document
        await whatsappDocRef.delete();
        console.log(`[🗑️ CLEANUP] Removed Firestore entry: ${whatsappFormat}`);

    } catch (error) {
        console.error(`[❌ ERROR] Failed to merge user profiles:`, error.message);
    }
}

// 🔥 Run the merge for your test number
mergeUserProfiles("19053279955");
