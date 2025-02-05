// transcriptionService.js - Google Cloud Speech-to-Text Integration (Vercel-Compatible)

const speech = require('@google-cloud/speech');
const ffmpeg = require('fluent-ffmpeg');
const { Readable, PassThrough } = require('stream'); // ✅ Added PassThrough
const client = new speech.SpeechClient();
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');

const speechBase64 = process.env.GOOGLE_SPEECH_CREDENTIALS_BASE64;
if (!speechBase64) {
    throw new Error("[ERROR] Missing GOOGLE_SPEECH_CREDENTIALS_BASE64 in environment variables.");
}

// ✅ Decode Base64 and write to a temporary file
const speechCredentialsPath = "/tmp/google-speech-key.json";
fs.writeFileSync(speechCredentialsPath, Buffer.from(speechBase64, 'base64'));

// ✅ Set GOOGLE_APPLICATION_CREDENTIALS dynamically for Speech-to-Text API
process.env.GOOGLE_APPLICATION_CREDENTIALS = speechCredentialsPath;
console.log("[DEBUG] Google Speech-to-Text Application Credentials set successfully.");

// Tell fluent-ffmpeg where to find ffmpeg binary
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Converts OGG_OPUS audio to FLAC **in memory** (No File System)
 * @param {Buffer} audioBuffer - OGG_OPUS audio buffer
 * @returns {Promise<Buffer>} - FLAC audio buffer
 */
async function convertOggToFlac(audioBuffer) {
    return new Promise((resolve, reject) => {
        const inputStream = new Readable();
        inputStream.push(audioBuffer);
        inputStream.push(null);

        const outputStream = new PassThrough(); // ✅ Fix: Use PassThrough Stream
        let outputBuffer = Buffer.alloc(0);

        outputStream.on('data', (chunk) => {
            outputBuffer = Buffer.concat([outputBuffer, chunk]);
        });

        outputStream.on('finish', () => {
            console.log('[DEBUG] Audio conversion to FLAC complete.');
            resolve(outputBuffer);
        });

        outputStream.on('error', (err) => {
            console.error('[ERROR] Audio conversion failed:', err);
            reject(err);
        });

        ffmpeg()
            .input(inputStream)
            .audioCodec('flac')
            .format('flac') // ✅ Ensuring FLAC output format
            .pipe(outputStream, { end: true }); // ✅ Fix: Allow correct stream ending
    });
}

/**
 * Transcribes an audio buffer using Google Cloud Speech-to-Text
 * @param {Buffer} audioBuffer - The audio file buffer (OGG_OPUS)
 * @returns {Promise<string|null>} - Transcribed text or null if failed
 */
async function transcribeAudio(audioBuffer) {
    try {
        console.log("[DEBUG] Converting OGG_OPUS to FLAC...");
        const flacBuffer = await convertOggToFlac(audioBuffer);

        console.log("[DEBUG] Sending FLAC audio for transcription...");
        
        const request = {
            audio: {
                content: flacBuffer.toString('base64'),
            },
            config: {
                encoding: 'FLAC',  // ✅ Using FLAC instead of OGG_OPUS
                sampleRateHertz: 16000,  // ✅ Google's STT prefers 16kHz
                languageCode: 'en-US',
                enableAutomaticPunctuation: true,  // ✅ Improves readability
                enableWordTimeOffsets: true,  // ✅ Adds timestamps if needed
            },
        };

        const [response] = await client.recognize(request);
        const transcription = response.results
            .map(result => result.alternatives[0].transcript)
            .join(' ');

        console.log(`[DEBUG] Transcription Result: ${transcription}`);
        return transcription || null;
    } catch (error) {
        console.error("[ERROR] Google Speech-to-Text failed:", error.message);
        return null;
    }
}

module.exports = { transcribeAudio };
