// netlify/functions/gemini-tts.js
exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  if (!process.env.GEMINI_API_KEY) {
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: 'API key not configured' })
    };
  }

  try {
    let requestBody;
    try {
      requestBody = JSON.parse(event.body);
    } catch (parseError) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          error: 'Invalid JSON in request body',
          details: parseError.message
        })
      };
    }

    const text = requestBody.text;
    const voiceName = requestBody.voiceName || 'Kore';

    // ✅ NEW: בחירת מודל
    // אפשר גם לשים ברירת־מחדל ב־ENV בשם GEMINI_TTS_MODEL
    const DEFAULT_TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
    const requestedModel = typeof requestBody.model === 'string' ? requestBody.model.trim() : '';
    const model = sanitizeModel(requestedModel) || DEFAULT_TTS_MODEL;

    // כדי למנוע שימוש במודל שאינו TTS (כי הבקשה כאן דורשת AUDIO)
    if (!isTTSModel(model)) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          error: 'Selected model is not a TTS-capable model',
          details: `Model "${model}" must be a Gemini TTS model (e.g., gemini-*-tts).`
        })
      };
    }

    const temperature = Math.min(Math.max(requestBody.temperature || 0.7, 0.0), 2.0);
    const topP = Math.min(Math.max(requestBody.topP || 0.9, 0.0), 1.0);
    const topK = Math.min(Math.max(requestBody.topK || 40, 1), 100);
    const maxOutputTokens = Math.min(Math.max(requestBody.maxOutputTokens || 8192, 1), 32768);
    const candidateCount = 1;
    const stopSequences = Array.isArray(requestBody.stopSequences) ? requestBody.stopSequences : [];

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

    // ✅ שימוש במודל הנבחר ב־URL
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          temperature,
          topP,
          topK,
          maxOutputTokens,
          candidateCount,
          stopSequences,
          responseModalities: ['AUDIO'],
          speechConfig
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
    const pcmBuffer = Buffer.from(audioBase64, 'base64');
    const wavBuffer = pcmToWav(pcmBuffer);

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
        modelUsed: model,            // ✅ נחמד לדיבוג
        audioData: wavBuffer.toString('base64'),
        mimeType: 'audio/wav',
        fileName: `tts_${Date.now()}.wav`
      })
    };

  } catch (error) {
    console.error('Error details:', error);
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

// ✅ NEW: סניטיזציה לשם המודל (למנוע תווים בעייתיים ב־URL)
function sanitizeModel(name) {
  if (!name) return '';
  const ok = /^[A-Za-z0-9._\-]+$/.test(name);
  return ok ? name : '';
}

// ✅ NEW: אימות בסיסי שמדובר במודל TTS
function isTTSModel(name) {
  // כלל אצבע: מודלי TTS ב-Gemini מכילים 'tts' בשם המודל.
  // אם תרצה, אפשר להחליף ל-allowlist ידני לפי מה שזמין אצלך.
  return typeof name === 'string' && /tts/i.test(name);
}

// קיימת אצלך
function pcmToWav(pcmBuffer, sampleRate, channels, bitsPerSample) {
  sampleRate = sampleRate || 24000;
  channels = channels || 1;
  bitsPerSample = bitsPerSample || 16;
  const length = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + length);

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

  pcmBuffer.copy(buffer, 44);
  return buffer;
}
