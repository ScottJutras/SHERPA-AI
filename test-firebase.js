const admin = require('firebase-admin');

// Replace 'your-service-account-key.json' with the path to your Firebase service account key
const serviceAccount = require('./test-firebase');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

async function testFirebase() {
  try {
    const db = admin.firestore();
    const testDoc = db.collection('test').doc('example');
    await testDoc.set({ message: 'Firebase is working!' });
    console.log('Data written to Firestore successfully!');
  } catch (error) {
    console.error('Error with Firebase:', error);
  }
}

testFirebase();
