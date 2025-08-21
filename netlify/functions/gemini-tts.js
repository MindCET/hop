// netlify/functions/gemini-tts.js
const TTS_MODELS = [
  "models/gemini-2.5-pro-preview-tts",
  "models/gemini-2.5-flash-preview-tts"
];

// נקבע ברירת מחדל (אפשר גם להגדיר GEMINI_TTS_MODEL ב־ENV)
const DEFAULT_TTS_MODEL = process.env.GEMINI_TTS_MODEL || TTS_MODELS[1];

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  if (!process.env.GEMINI_API_KEY) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
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
        headers: corsHeaders(),
        body: JSON.stringify({
          error: 'Invalid JSON in request body',
          details: parseError.message
        })
      };
    }

    const text = requestBody.text;
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'Valid text is required' })
      };
    }

    const voiceName = requestBody.voiceName || 'Kore';
    const requestedModel = typeof requestBody.model === 'string' ? requestBody.model.trim() : '';
    const model = TTS_MODELS.includes(requestedModel) ? requestedModel : DEFAULT_TTS_MODEL;

    // פרמטרים נוספים
    const temperature = Math.min(Math.max(requestBody.temperature || 0.7, 0.0), 2.0);
    const topP = Math.min(Math.max(requestBody.topP || 0.9, 0.0), 1.0);
    const topK = Math.min(Math.max(requestBody.topK || 40, 1), 100);
    const maxOutputTokens = Math.min(Math.max(requestBody.maxOutputTokens || 8192, 1), 32768);

    // הגדרות קול
    const speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName }
      }
    };

    // ✅ שליחת בקשה עם fallback בין המודלים
    const { audioBase64, modelUsed } = await tryModelsSequentially({
      text,
      model,
      voiceName,
      speechConfig,
      temperature,
      topP,
      topK,
      maxOutputTokens
    });

    const pcmBuffer = Buffer.from(audioBase64, 'base64');
    const wavBuffer = pcmToWav(pcmBuffer);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        success: true,
        modelUsed,
        audioData: wavBuffer.toString('base64'),
        mimeType: 'audio/wav',
        fileName: `tts_${Date.now()}.wav`
      })
    };

  } catch (error) {
    console.error('Error details:', error);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: 'Internal server error',
        details: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
};

// פונקציה שמנסה מודל ראשי ואז fallback
async function tryModelsSequentially({ text, model, voiceName, speechConfig, temperature, topP, topK, maxOutputTokens }) {
  const modelsToTry = [model, ...TTS_MODELS.filter(m => m !== model)];

  for (const m of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/${m}:generateContent`;

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
            candidateCount: 1,
            stopSequences: [],
            responseModalities: ['AUDIO'],
            speechConfig
          }
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`Gemini API error [${m}]:`, response.status, errText);

        if (response.status === 429) {
          console.warn(`Model ${m} quota exceeded, trying fallback...`);
          continue; // נעבור למודל הבא
        }

        throw new Error(`Gemini API error ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const audioBase64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!audioBase64) throw new Error('No audio data in response');

      return { audioBase64, modelUsed: m };

    } catch (err) {
      console.error(`Error with model ${m}:`, err.message);
      if (m === modelsToTry[modelsToTry.length - 1]) throw err; // האחרון? זורקים שגיאה
    }
  }
}

// Helper headers
function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

// Helper: PCM ➝ WAV
function pcmToWav(pcmBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
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
