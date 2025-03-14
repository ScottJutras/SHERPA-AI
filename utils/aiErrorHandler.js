// utils/aiErrorHandler.js
const OpenAI = require('openai');
const { getSubscriptionTier } = require('./tokenManager');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('./stateManager');
const { updateUserTokenUsage } = require('./tokenManager');

// 2️⃣ detectErrors() – Identifies Problems in User Input
function isValidDate(dateString) {
    return !isNaN(Date.parse(dateString));
}

function detectErrors(data, type = 'expense') {
    let errors = [];
    if (!data.amount || (type !== 'job' && isNaN(parseFloat(data.amount.replace('$', ''))))) {
        errors.push("Missing or incorrect amount");
    }
    if (type === 'expense' && (!data.store || data.store.length < 3)) {
        errors.push("Store name is missing or incorrect");
    }
    if (type === 'job' && (!data.jobName || data.jobName.length < 3)) {
        errors.push("Job name is missing or too short");
    }
    if (type === 'quote' && (!data.jobName || data.jobName.length < 3)) {
        errors.push("Job name is missing or too short");
    }
    if (!data.date || !isValidDate(data.date)) {
        errors.push("Invalid or missing date");
    }
    return errors.length ? errors.join(", ") : null;
}

// 3️⃣ correctErrorsWithAI() – Uses GPT to Suggest Fixes
async function correctErrorsWithAI(errorMessage) {
    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    try {
        const response = await openaiClient.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: `Given an error message about user input, suggest corrections as a JSON object. Error: "${errorMessage}"` },
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

// 1️⃣ handleInputWithAI() – Detects & Handles Errors, Available to All Tiers
async function handleInputWithAI(from, input, type, parseFn, defaultData = {}) {
    const subscriptionTier = await getSubscriptionTier(from); // Still fetch tier for potential logging or future use
    const pendingState = await getPendingTransactionState(from);
    let data = parseFn(input);

    // If parsing fails, use default data and check for errors
    if (!data) {
        const errors = detectErrors(defaultData, type);
        if (errors) {
            const corrections = await correctErrorsWithAI(`Error in ${type} input: ${input} - ${errors}`);
            if (corrections) {
                return { data: { ...defaultData, ...corrections }, reply: null, confirmed: false };
            }
            return { data: null, reply: `🤔 I couldn’t parse "${input}" as a ${type}. Please try again.`, confirmed: false };
        }
        data = defaultData;
    }

    // Handle pending corrections
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

    // If parsed data is missing or incomplete, attempt AI fallback for all tiers
    if (!data || Object.keys(data).length === 0) {
        const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const gptResponse = await openaiClient.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: `Extract structured ${type} data from: "${input}". Return JSON with keys: ${type === 'expense' ? 'date, item, amount, store' : 'date, description, amount, client'}.` },
                { role: "user", content: input }
            ],
            max_tokens: 60,
            temperature: 0.3
        });
        data = JSON.parse(gptResponse.choices[0].message.content);
        await updateUserTokenUsage(from, gptResponse.usage.total_tokens); // Track usage for all tiers
    }

    // Check for errors in parsed or AI-extracted data
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

    // If all checks pass, return confirmed data
    return { data, reply: null, confirmed: true };
}

module.exports = {
    handleInputWithAI,
    detectErrors,
    correctErrorsWithAI
};