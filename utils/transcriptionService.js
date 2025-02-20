// transcriptionService.js - Google Cloud Speech-to-Text Integration (Vercel-Compatible)

const speech = require('@google-cloud/speech');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
const client = new speech.SpeechClient();
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const OpenAI = require('openai');

ffmpeg.setFfmpegPath(ffmpegInstaller.path); // ✅ Ensure ffmpeg binary is found

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Transcribes an audio buffer using Google Cloud Speech-to-Text (OGG_OPUS first, then FLAC if needed)
 * @param {Buffer} audioBuffer - The audio file buffer (OGG_OPUS)
 * @returns {Promise<string|null>} - Transcribed text or null if failed
 */
async function transcribeAudio(audioBuffer) {
    try {
        console.log("[DEBUG] Attempting direct OGG_OPUS transcription...");
        let transcription = await transcribeDirect(audioBuffer);
        if (transcription) return transcription;

        console.log("[DEBUG] Direct transcription failed. Converting to FLAC...");
        const { flacBuffer, sampleRate } = await convertOggToFlac(audioBuffer);
        transcription = await transcribeFlac(flacBuffer, sampleRate);
        return transcription;
    } catch (error) {
        console.error("[ERROR] Google Speech-to-Text failed:", error.message);
        return null;
    }
}

async function transcribeDirect(audioBuffer) {
    try {
        const request = {
            audio: { content: audioBuffer.toString('base64') },
            config: getSpeechConfig('OGG_OPUS', 48000),
        };
        const [response] = await client.recognize(request);
        return processTranscription(response);
    } catch (error) {
        console.warn("[WARN] Direct OGG transcription failed:", error.message);
        return null;
    }
}

async function transcribeFlac(flacBuffer, sampleRate) {
    try {
        const request = {
            audio: { content: flacBuffer.toString('base64') },
            config: getSpeechConfig('FLAC', sampleRate),
        };
        const [response] = await client.recognize(request);
        return processTranscription(response);
    } catch (error) {
        console.error("[ERROR] FLAC transcription failed:", error.message);
        return null;
    }
}

function getSpeechConfig(encoding, sampleRate) {
    return {
        encoding,
        sampleRateHertz: sampleRate,
        languageCode: 'en-US',
        enableAutomaticPunctuation: true,
        enableWordTimeOffsets: true,
        speechContexts: [{
            phrases: [
                'Roofmart', 'Home Depot', 'Lowe\'s', 'Rona', 'Menards', 
                'Canadian Tire', 'Ace Hardware', 'Sherwin-Williams', 'Benjamin Moore',
                'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
                'hundred', 'thousand', 'dollars', 'bucks', 'ninety', 'sixty', 'fifty', 'twenty'
            ],
            boost: 15
        }]
    };
}

function processTranscription(response) {
    if (!response.results || response.results.length === 0) return null;
    
    response.results.forEach((result, index) => {
        console.log(`[DEBUG] Confidence ${index}:`, result.alternatives[0].confidence);
    });
    
    return response.results.map(result => result.alternatives[0].transcript).join(' ');
}

async function convertOggToFlac(audioBuffer) {
    return new Promise((resolve, reject) => {
        const inputStream = new PassThrough(); 
        inputStream.end(audioBuffer);
        const outputStream = new PassThrough();
        let outputBuffer = Buffer.alloc(0);
        let detectedSampleRate = 48000;

        outputStream.on('data', (chunk) => {
            outputBuffer = Buffer.concat([outputBuffer, chunk]);
        });
        outputStream.on('finish', () => {
            console.log(`[DEBUG] Audio conversion to FLAC complete. Detected sample rate: ${detectedSampleRate}`);
            resolve({ flacBuffer: outputBuffer, sampleRate: detectedSampleRate });
        });
        outputStream.on('error', reject);

        ffmpeg()
            .input(inputStream)
            .inputFormat('ogg')
            .audioCodec('flac')
            .format('flac')
            .on('stderr', (line) => {
                const match = line.match(/(\d+) Hz/);
                if (match) detectedSampleRate = parseInt(match[1], 10);
            })
            .on('end', () => outputStream.end())
            .on('error', reject)
            .pipe(outputStream);
    });
}

async function inferMissingData(text) {
    try {
        console.log("[DEBUG] Using GPT to infer missing data (amount & store name)...");
        const response = await openaiClient.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: "Extract numbers and store names from this transcribed text. If a store name is incorrect, correct it based on common construction-related stores." },
                { role: "user", content: `Transcription: \"${text}\"` }
            ],
            max_tokens: 20
        });
        return JSON.parse(response.choices[0].message.content.trim());
    } catch (error) {
        console.error("[ERROR] GPT-3.5 failed to infer data:", error.message);
        return null;
    }
}

module.exports = { transcribeAudio, inferMissingData };
