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
    
    // פרמטרים נוספים עם ברירת מחדל ו-validation
    const temperature = Math.min(Math.max(requestBody.temperature || 0.7, 0.0), 2.0);
    const topP = Math.min(Math.max(requestBody.topP || 0.9, 0.0), 1.0);
    const topK = Math.min(Math.max(requestBody.topK || 40, 1), 100);
    const maxOutputTokens = Math.min(Math.max(requestBody.maxOutputTokens || 8192, 1), 32768);
    const candidateCount = 1; // תמיד 1 ל-TTS
    const stopSequences = Array.isArray(requestBody.stopSequences) ? requestBody.stopSequences : [];
    
    // פרמטרים של multi-speaker (אופציונלי)
    const multiSpeaker = requestBody.multiSpeaker || false;
    const speakerConfigs = Array.isArray(requestBody.speakerConfigs) ? requestBody.speakerConfigs : [];
    
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Valid text is required' })
      };
    }

    // בניית speechConfig בהתאם לפרמטרים
    let speechConfig;
    if (multiSpeaker && speakerConfigs.length > 0) {
      speechConfig = {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: speakerConfigs.map(config => ({
            speaker: config.speaker,
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: config.voiceName || 'Kore'
              }
            }
          }))
        }
      };
    } else {
      speechConfig = {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceName
          }
        }
      };
    }

    // קריאה ל-Gemini API עם פרמטרים מתקדמים
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
          temperature: temperature,
          topP: topP,
          topK: topK,
          maxOutputTokens: maxOutputTokens,
          candidateCount: candidateCount,
          stopSequences: stopSequences,
          responseModalities: ['AUDIO'],
          speechConfig: speechConfig
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API error:', response.status, errorText);
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('Gemini response:', JSON.stringify(data, null, 2));
    
    // בדיקה שהתגובה תקינה
    if (!data.candidates || data.candidates.length === 0) {
      throw new Error('No candidates in response');
    }
    
    const candidate = data.candidates[0];
    if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
      throw new Error('No content parts in response');
    }
    
    const part = candidate.content.parts[0];
    if (!part.inlineData || !part.inlineData.data) {
      throw new Error('No inline data in response part');
    }
    
    const audioBase64 = part.inlineData.data;
    
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
    console.error('Error details:', error);
    
    // לוג נוסף למקרה של שגיאת parsing
    if (error.message.includes('JSON')) {
      console.error('JSON parsing error, raw response might be available');
    }
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({ 
        error: 'Internal server error',
        details: error.message,
        timestamp: new Date().toISOString()
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
