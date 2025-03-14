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
async function correctErrorsWithAI(errorDetails) {
  const prompt = `Fix the following errors in an expense log: "${errorDetails}". Provide corrections as a structured JSON object with fields: amount, store, and date.`;
  try {
    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const gptResponse = await openaiClient.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "system", content: prompt }],
      max_tokens: 50,
      temperature: 0.3
    });
    return JSON.parse(gptResponse.choices[0].message.content);
  } catch (error) {
    console.error("[ERROR] AI correction failed:", error.message);
    return null;
  }
}

// 1️⃣ handleInputWithAI() – Detects & Handles Errors
async function handleInputWithAI(from, input, type, parseFn, defaultData = {}) {
  const subscriptionTier = await getSubscriptionTier(from);
  const pendingState = await getPendingTransactionState(from);
  let data = parseFn(input) || defaultData;

  // Handle pending corrections
  if (pendingState && pendingState.pendingCorrection) {
    if (input.toLowerCase() === 'yes') {
      data = { ...pendingState.pendingData, ...pendingState.suggestedCorrections };
      await deletePendingTransactionState(from);
      return { data, confirmed: true };
    } else if (input.toLowerCase() === 'no') {
      await deletePendingTransactionState(from);
      await setPendingTransactionState(from, { isEditing: true, type });
      return { data: null, reply: `✏️ Please provide the correct ${type} details.` };
    }
  }

  // If parsed data is missing or incomplete, attempt AI fallback
  if (!data || Object.keys(data).length === 0) {
    if (subscriptionTier !== 'free') {
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
      await updateUserTokenUsage(from, gptResponse.usage.total_tokens);
    }
    if (!data || Object.keys(data).length === 0) {
      // Simplified AI fallback for all users
      data = { ...defaultData, rawInput: input };
      const errors = detectErrors(data, type);
      const corrections = await correctErrorsWithAI(errors);
      if (corrections) {
        await setPendingTransactionState(from, { pendingData: data, pendingCorrection: true, suggestedCorrections: corrections, type });
        const correctionText = Object.entries(corrections).map(([k, v]) => `${k}: ${v}`).join('\n');
        return { data: null, reply: `🤔 I couldn’t parse "${input}". Did you mean:\n${correctionText}\nReply 'yes' to accept or 'no' to edit.` };
      }
    }
  }

  // Check for errors in parsed data
  const errors = detectErrors(data, type);
  if (errors) {
    const corrections = await correctErrorsWithAI(errors);
    if (corrections) {
      await setPendingTransactionState(from, { pendingData: data, pendingCorrection: true, suggestedCorrections: corrections, type });
      const correctionText = Object.entries(corrections).map(([k, v]) => `${k}: ${data[k]} → ${v}`).join('\n');
      return { data: null, reply: `🤔 Detected issues in ${type}:\n${correctionText}\nReply 'yes' to accept or 'no' to edit.` };
    }
  }
  return { data, confirmed: true };
}

module.exports = {
  handleInputWithAI,
  detectErrors,
  correctErrorsWithAI
};
