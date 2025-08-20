// netlify/functions/gemini-tts.js
exports.handler = async (event, context) => {
  // בדיקת HTTP method
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const requestBody = JSON.parse(event.body);
    const text = requestBody.text;
    const voiceName = requestBody.voiceName || 'Kore';
    
    if (!text) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Text is required' })
      };
    }

    // קריאה ל-Gemini API
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent', {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: text
          }]
        }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voiceName
              }
            }
          }
        }
      })
    });

    if (!response.ok) {
      throw new Error('Gemini API error');
    }

    const data = await response.json();
    const audioBase64 = data.candidates[0].content.parts[0].inlineData.data;
    
    // המרת base64 לPCM
    const pcmBuffer = Buffer.from(audioBase64, 'base64');
    
    // המרה לWAV (פונקציה פשוטה)
    const wavBuffer = pcmToWav(pcmBuffer);
    
    // החזרת הקובץ כbase64 ל-Bubble
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({
        success: true,
        audioData: wavBuffer.toString('base64'),
        mimeType: 'audio/wav',
        fileName: `tts_${Date.now()}.wav`
      })
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Internal server error',
        details: error.message 
      })
    };
  }
};

// פונקציה להמרת PCM ל-WAV
function pcmToWav(pcmBuffer, sampleRate, channels, bitsPerSample) {
  sampleRate = sampleRate || 24000;
  channels = channels || 1;
  bitsPerSample = bitsPerSample || 16;
  const length = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + length);
  
  // WAV Header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + length, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  buffer.writeUInt16LE(channels * bitsPerSample / 8, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(length, 40);
  
  // PCM Data
  pcmBuffer.copy(buffer, 44);
  
  return buffer;
}
