const admin = require('firebase-admin');

// Check if Firebase is already initialized (prevents duplicate initialization)
if (!admin.apps.length) {
  const credsBase64 = process.env.FIREBASE_CREDENTIALS_BASE64;
  if (!credsBase64) {
    console.error("[ERROR] FIREBASE_CREDENTIALS_BASE64 is not set in environment variables.");
    process.exit(1);
  }
  
  // Decode and parse the credentials
  const decodedCreds = Buffer.from(credsBase64, 'base64').toString('utf8');
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(decodedCreds);
  } catch (error) {
    console.error("Failed to parse Firebase credentials JSON:", error);
    process.exit(1);
  }

  // Initialize Firebase Admin SDK
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  console.log("[✅] Firebase Admin initialized successfully.");
}

const db = admin.firestore();

// Define the document IDs
const normalizedUserId = "19053279955";
const duplicateUserId = "whatsapp:+19053279955";

async function mergeUserEntries() {
  try {
    // Retrieve both documents concurrently
    const [normalizedDoc, duplicateDoc] = await Promise.all([
      db.collection('users').doc(normalizedUserId).get(),
      db.collection('users').doc(duplicateUserId).get()
    ]);

    // Ensure the duplicate document exists
    if (!duplicateDoc.exists) {
      console.log(`Duplicate document ${duplicateUserId} does not exist.`);
      return;
    }

    // Get data from the documents
    const normalizedData = normalizedDoc.exists ? normalizedDoc.data() : {};
    const duplicateData = duplicateDoc.data();

    // Merge the two objects (customize the merging strategy as needed)
    // Note: Fields in normalizedData override duplicateData in case of conflict.
    const mergedData = {
      ...duplicateData,
      ...normalizedData
    };

    // Update the normalized document with the merged data
    await db.collection('users').doc(normalizedUserId).set(mergedData, { merge: true });

    // Delete the duplicate document
    await db.collection('users').doc(duplicateUserId).delete();

    console.log("Merge complete. Duplicate entry removed.");
  } catch (error) {
    console.error("Error merging documents:", error);
  }
}

mergeUserEntries();
