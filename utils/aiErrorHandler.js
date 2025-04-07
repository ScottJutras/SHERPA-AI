const OpenAI = require('openai');
const { getSubscriptionTier, updateUserTokenUsage } = require('./tokenManager');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('./stateManager');

function isValidDate(dateString) {
    return !isNaN(Date.parse(dateString));
}

function detectErrors(data, type = 'expense') {
    let errors = [];
    if (!data.amount || isNaN(parseFloat(data.amount.replace('$', '')))) {
        errors.push("Missing or incorrect amount");
    }
    if (type === 'expense') {
        if (!data.store || data.store.length < 3) errors.push("Store name is missing or too short");
        if (!data.item || data.item.length < 2) errors.push("Item name is missing or too short");
    }
    if (type === 'job' && (!data.jobName || data.jobName.length < 3)) {
        errors.push("Job name is missing or too short");
    }
    if (type === 'quote' && (!data.jobName || data.jobName.length < 3)) {
        errors.push("Job name is missing or too short");
    }
    if (!data.date || !isValidDate(data.date) || data.date > new Date().toISOString().split('T')[0]) {
        errors.push("Invalid or future date");
    }
    return errors.length ? errors.join(", ") : null;
}

async function correctErrorsWithAI(errorMessage) {
    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    try {
        const response = await openaiClient.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: `Suggest corrections for: "${errorMessage}". Return JSON with corrected fields.` },
                { role: "user", content: "Suggest corrections." }
            ],
            max_tokens: 100,
            temperature: 0.3
        });
        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        console.error("[ERROR] AI correction failed:", error.message);
        return null;
    }
}

async function handleInputWithAI(from, input, type, parseFn, defaultData = {}) {
    const pendingState = await getPendingTransactionState(from);
    let data = await parseFn(input);

    if (pendingState && pendingState.pendingCorrection) {
        if (input.toLowerCase() === 'yes') {
            data = { ...pendingState.pendingData, ...pendingState.suggestedCorrections };
            await deletePendingTransactionState(from);
            return { data, reply: null, confirmed: true };
        } else if (input.toLowerCase() === 'no') {
            await deletePendingTransactionState(from);
            await setPendingTransactionState(from, { isEditing: true, type });
            return { data: null, reply: `✏️ Please provide the correct ${type} details.`, confirmed: false };
        }
    }

    if (!data) {
        return { data: null, reply: `🤔 I couldn’t parse "${input}" as a ${type}. Please try again.`, confirmed: false };
    }

    const errors = detectErrors(data, type);
    if (errors) {
        const corrections = await correctErrorsWithAI(`Error in ${type} input: ${input} - ${errors}`);
        if (corrections) {
            await setPendingTransactionState(from, { pendingData: data, pendingCorrection: true, suggestedCorrections: corrections, type });
            const correctionText = Object.entries(corrections).map(([k, v]) => `${k}: ${data[k] || 'missing'} → ${v}`).join('\n');
            return { data: null, reply: `🤔 Detected issues in ${type}:\n${correctionText}\nReply 'yes' to accept or 'no' to edit.`, confirmed: false };
        }
        return { data: null, reply: `⚠️ Issues with ${type}: ${errors}. Please correct and resend.`, confirmed: false };
    }

    return { data, reply: null, confirmed: true };
}

module.exports = { handleInputWithAI, detectErrors, correctErrorsWithAI };