// transcriptionService.js - Google Cloud Speech-to-Text Integration

const speech = require('@google-cloud/speech');
const ffmpeg = require('fluent-ffmpeg'); // ✅ Audio conversion
const fs = require('fs');
const path = require('path');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

// ✅ Tell fluent-ffmpeg where to find ffmpeg binary
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Converts OGG_OPUS audio to FLAC format for Google Speech-to-Text
 * @param {Buffer} audioBuffer - OGG_OPUS audio buffer
 * @returns {Promise<Buffer>} - FLAC audio buffer
 */
async function convertOggToFlac(audioBuffer) {
    return new Promise((resolve, reject) => {
        const tempInput = path.join(__dirname, 'temp_input.ogg');
        const tempOutput = path.join(__dirname, 'temp_output.flac');

        // Write the OGG audio to a temporary file
        fs.writeFileSync(tempInput, audioBuffer);

        ffmpeg(tempInput)
            .output(tempOutput)
            .toFormat('flac') // ✅ Convert to FLAC for Google STT
            .on('end', () => {
                console.log('[DEBUG] Audio conversion to FLAC complete.');
                
                try {
                    // ✅ Read file **before deleting**
                    const convertedAudio = fs.readFileSync(tempOutput);
                    
                    // ✅ Cleanup temp files
                    fs.unlinkSync(tempInput);
                    fs.unlinkSync(tempOutput);
                    
                    resolve(convertedAudio);
                } catch (err) {
                    console.error('[ERROR] Failed to read converted audio:', err);
                    reject(err);
                }
            })
            .on('error', (err) => {
                console.error('[ERROR] Audio conversion failed:', err);
                reject(err);
            })
            .run();
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
