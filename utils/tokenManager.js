const admin = require('firebase-admin');
const db = admin.firestore();

async function getUserTokenUsage(from, resetIfNewMonth = true) {
    const userRef = db.collection('users').doc(from);
    const userDoc = await userRef.get();
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;

    let usageData = userDoc.exists ? userDoc.data().tokenUsage || {} : {};
    if (resetIfNewMonth && (!usageData.lastReset || usageData.lastReset !== currentMonth)) {
        usageData = { tokensUsed: 0, lastReset: currentMonth };
    }
    return usageData;
}

async function updateUserTokenUsage(from, tokensUsed) {
    const userRef = db.collection('users').doc(from);
    const usageData = await getUserTokenUsage(from);
    usageData.tokensUsed = (usageData.tokensUsed || 0) + tokensUsed;
    await userRef.set({ tokenUsage: usageData }, { merge: true });
}

async function checkTokenLimit(from, subscriptionTier) {
    const usageData = await getUserTokenUsage(from);
    const limits = {
        'free': 0,
        'ai-assisted': 10000,
        'advanced': 20000,
        'pro': Infinity
    };
    const limit = limits[subscriptionTier] || 0;
    return usageData.tokensUsed < limit;
}

async function getSubscriptionTier(from) {
    const userProfile = await require('../googleSheets').getUserProfile(from);
    return userProfile?.subscription_tier || 'free';
}

async function addPurchasedTokens(from, tokenCount) {
    const usageData = await getUserTokenUsage(from, false);
    usageData.tokensUsed = Math.max(0, usageData.tokensUsed - tokenCount);
    await db.collection('users').doc(from).set({ tokenUsage: usageData }, { merge: true });
}

module.exports = { getUserTokenUsage, updateUserTokenUsage, checkTokenLimit, getSubscriptionTier, addPurchasedTokens };