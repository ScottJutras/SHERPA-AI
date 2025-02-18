// transcriptionService.js - Google Cloud Speech-to-Text Integration (Vercel-Compatible)

const speech = require('@google-cloud/speech');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
const client = new speech.SpeechClient();
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

ffmpeg.setFfmpegPath(ffmpegInstaller.path); // ✅ Ensure ffmpeg binary is found

/**
 * Converts OGG_OPUS audio to FLAC and extracts sample rate.
 * @param {Buffer} audioBuffer - OGG_OPUS audio buffer
 * @returns {Promise<{ flacBuffer: Buffer, sampleRate: number }>} - FLAC buffer and sample rate
 */
async function convertOggToFlac(audioBuffer) {
    return new Promise((resolve, reject) => {
        const inputStream = new PassThrough(); 
        inputStream.end(audioBuffer); // ✅ Fix: Properly pass buffer

        const outputStream = new PassThrough();
        let outputBuffer = Buffer.alloc(0);
        let detectedSampleRate = 48000; // Default to WhatsApp's sample rate

        outputStream.on('data', (chunk) => {
            outputBuffer = Buffer.concat([outputBuffer, chunk]);
        });

        outputStream.on('finish', () => {
            console.log(`[DEBUG] Audio conversion to FLAC complete. Detected sample rate: ${detectedSampleRate}`);
            resolve({ flacBuffer: outputBuffer, sampleRate: detectedSampleRate });
        });

        outputStream.on('error', (err) => {
            console.error('[ERROR] Audio conversion failed:', err);
            reject(err);
        });

        // ✅ Extract sample rate and convert to FLAC
        ffmpeg()
            .input(inputStream)
            .inputFormat('ogg')
            .audioCodec('flac')
            .format('flac')
            .on('stderr', (line) => {
                const match = line.match(/(\d+) Hz/);
                if (match) {
                    detectedSampleRate = parseInt(match[1], 10);
                }
            })
            .on('end', () => outputStream.end()) // ✅ Ensure stream closes correctly
            .on('error', (err) => reject(err))
            .pipe(outputStream);
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
        const { flacBuffer, sampleRate } = await convertOggToFlac(audioBuffer);

        console.log(`[DEBUG] Sending FLAC audio for transcription (Sample Rate: ${sampleRate})...`);
        
        const request = {
            audio: {
                content: flacBuffer.toString('base64'),
            },
            config: {
                encoding: 'FLAC',
                sampleRateHertz: sampleRate,  // ✅ Use detected sample rate
                languageCode: 'en-US',
                enableAutomaticPunctuation: true,
                enableWordTimeOffsets: true,
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
