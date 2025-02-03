const { google } = require('googleapis');
const admin = require('firebase-admin');

// ✅ Load Google Credentials from Base64
let googleCredentials;
if (process.env.GOOGLE_CREDENTIALS_BASE64) {
    try {
        googleCredentials = JSON.parse(
            Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
        );
        console.log("[DEBUG] Successfully loaded Google Credentials from Base64.");
    } catch (error) {
        console.error("[ERROR] Failed to decode GOOGLE_CREDENTIALS_BASE64:", error.message);
        process.exit(1);
    }
} else {
    console.error("[ERROR] GOOGLE_CREDENTIALS_BASE64 is not set in environment variables.");
    process.exit(1);
}

// ✅ Initialize Firebase Admin SDK
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
        console.log("[DEBUG] Firebase Admin initialized successfully.");
    } catch (error) {
        console.error("[ERROR] Failed to initialize Firebase Admin:", error.message);
        process.exit(1);
    }
}
const db = admin.firestore();

// ✅ Google API Scopes
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'];

// ✅ Function to initialize Google API client
async function getAuthorizedClient() {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: googleCredentials,
            scopes: SCOPES,
        });
        console.log('[DEBUG] Google API client authorized successfully.');
        return auth;
    } catch (error) {
        console.error('[ERROR] Failed to authorize Google API client:', error.message);
        throw error;
    }
}

// ✅ Function to create a new Google Spreadsheet for a user
async function createSpreadsheetForUser(phoneNumber) {
    try {
        console.log(`[DEBUG] Creating a new spreadsheet for user: ${phoneNumber}`);

        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });

        const response = await sheets.spreadsheets.create({
            resource: {
                properties: { title: `Expenses - ${phoneNumber}` },
                sheets: [
                    {
                        properties: { title: 'Sheet1' },
                        data: {
                            rowData: [
                                {
                                    values: [
                                        { userEnteredValue: { stringValue: 'Date' } },
                                        { userEnteredValue: { stringValue: 'Item' } },
                                        { userEnteredValue: { stringValue: 'Amount' } },
                                        { userEnteredValue: { stringValue: 'Store' } },
                                        { userEnteredValue: { stringValue: 'Job' } }
                                    ]
                                }
                            ]
                        }
                    }
                ]
            }
        });

        console.log(`[✅ SUCCESS] Spreadsheet created: ${response.data.spreadsheetId}`);
        return response.data.spreadsheetId;
    } catch (error) {
        console.error(`[❌ ERROR] Failed to create spreadsheet for ${phoneNumber}:`, error.message);
        throw error;
    }
}

// ✅ Function to retrieve or create a spreadsheet for a user
async function getOrCreateUserSpreadsheet(phoneNumber) {
    try {
        const userDoc = db.collection('users').doc(phoneNumber);
        const userSnapshot = await userDoc.get();

        if (userSnapshot.exists && userSnapshot.data().spreadsheetId) {
            return userSnapshot.data().spreadsheetId;
        }

        console.log(`[DEBUG] No spreadsheet found for user (${phoneNumber}). Creating a new one.`);
        const spreadsheetId = await createSpreadsheetForUser(phoneNumber);

        await userDoc.set({ spreadsheetId }, { merge: true });
        console.log(`[✅ SUCCESS] Spreadsheet created and saved to Firebase for user (${phoneNumber}): ${spreadsheetId}`);

        return spreadsheetId;
    } catch (error) {
        console.error(`[❌ ERROR] Failed to retrieve or create spreadsheet for user (${phoneNumber}):`, error.message);
        throw error;
    }
}

// ✅ Function to append data to a user's spreadsheet
async function appendToUserSpreadsheet(phoneNumber, data) {
    try {
        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });

        console.log(`[DEBUG] Retrieving spreadsheet for ${phoneNumber}`);
        const spreadsheetId = await getOrCreateUserSpreadsheet(phoneNumber);
        console.log(`[DEBUG] Using Spreadsheet ID: ${spreadsheetId}`);

        const RANGE = 'Sheet1!A:E'; // Columns: Date, Item, Amount, Store, Job

        const resource = {
            values: [data], // Append data
        };

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: RANGE,
            valueInputOption: 'USER_ENTERED',
            resource,
        });

        console.log(`[✅ SUCCESS] Data successfully appended to spreadsheet (${spreadsheetId}): ${JSON.stringify(data)}`);
    } catch (error) {
        console.error('[❌ ERROR] Failed to append data to spreadsheet:', error.message);
        throw error;
    }
}

// ✅ Function to fetch expenses filtered by job
async function fetchExpenseData(phoneNumber, jobName) {
    try {
        const spreadsheetId = await getOrCreateUserSpreadsheet(phoneNumber);
        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });

        const RANGE = 'Sheet1!A:E'; // Columns: Date, Item, Amount, Store, Job
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: RANGE,
        });

        const rows = response.data.values;
        if (!rows || rows.length <= 1) {
            console.log('[DEBUG] No expense data found.');
            return [];
        }

        return rows.slice(1)
            .filter(row => row[4] === jobName)
            .map(row => ({
                date: row[0],
                item: row[1],
                amount: parseFloat(row[2].replace('$', '')) || 0,
                store: row[3],
                job: row[4]
            }));
    } catch (error) {
        console.error('[ERROR] Failed to fetch expense data:', error.message);
        throw error;
    }
}

// ✅ Function to set the active job for a user (RESTORED)
async function setActiveJob(phoneNumber, jobName) {
    try {
        await db.collection('users').doc(phoneNumber).set({ activeJob: jobName }, { merge: true });
        console.log(`[✅ SUCCESS] Active job set for ${phoneNumber}: ${jobName}`);
    } catch (error) {
        console.error('[❌ ERROR] Failed to set active job:', error.message);
        throw error;
    }
}

// ✅ Function to get the active job for a user (RESTORED)
async function getActiveJob(phoneNumber) {
    try {
        const userDoc = await db.collection('users').doc(phoneNumber).get();
        return userDoc.exists ? userDoc.data().activeJob : null;
    } catch (error) {
        console.error('[❌ ERROR] Failed to retrieve active job:', error.message);
        throw error;
    }
}

// ✅ Function to parse receipt text from OCR (IMPROVED)
function parseReceiptText(text) {
    try {
        console.log("[DEBUG] Raw OCR Text:", text);
        const lines = text.split('\n').map(line => line.trim());

        // Extract Store Name (Usually at the top of the receipt)
        let store = lines[0] || "Unknown Store";

        // Extract Date
        let dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4}|\d{2}\/\d{2}\/\d{2})/);
        let date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

        // Extract Amount (Handles both "$24.60" and "24.60")
        let amountMatch = text.match(/(?:\$|)(\d{1,6}\.\d{2})/g);
        let amount = amountMatch ? `$${amountMatch[amountMatch.length - 1]}` : "Unknown Amount";

        // Extract Items (Handles "2x4", "nails", "paint", etc.)
        let items = [];
        const materialKeywords = [
            "lumber", "wood", "2x4", "plywood", "screws", "nails", "cement", "gravel", "drywall",
            "paint", "primer", "tiles", "shingles", "gutters", "insulation", "concrete", "sand",
            "flooring", "adhesive", "sealant", "tape", "bricks", "mortar", "plumbing", "electrical", "wire"
        ];
        let materialMatch = text.match(new RegExp(`\\b(${materialKeywords.join("|")})\\b`, "i"));
        if (materialMatch) {
            items.push(materialMatch[1]);
        }

        // Check for quantity-based items (e.g., "20 2x4s")
        let quantityItemMatch = text.match(/(\d+)\s+(\w+)/);
        if (quantityItemMatch) {
            items.push(`${quantityItemMatch[1]} ${quantityItemMatch[2]}`);
        }

        return {
            date,
            item: items.join(", ") || "Unknown Items",
            amount,
            store
        };
    } catch (error) {
        console.error("[ERROR] Failed to parse receipt text:", error.message);
        return null;
    }
}
// ✅ Function to log receipt-based expenses
async function logReceiptExpense(phoneNumber, extractedText) {
    const parsedData = parseReceiptText(extractedText);
    if (!parsedData) {
        console.error("[ERROR] Failed to parse OCR data.");
        return;
    }
    return appendToUserSpreadsheet(phoneNumber, [
        parsedData.date,
        parsedData.item,
        parsedData.amount,
        parsedData.store
    ]);
}

// ✅ Exporting all required functions
module.exports = {
    appendToUserSpreadsheet,
    fetchExpenseData,
    logReceiptExpense,
    getOrCreateUserSpreadsheet,
    setActiveJob,  // FIXED & RESTORED
    getActiveJob,  // FIXED & RESTORED
    createSpreadsheetForUser,
};
