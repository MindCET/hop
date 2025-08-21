// netlify/functions/gemini-tts.js

// ----- מודלים מותרים (TTS) -----
const TTS_MODELS = [
  "models/gemini-2.5-pro-preview-tts",
  "models/gemini-2.5-flash-preview-tts"
];

// ברירת מחדל (אפשר לעקוף עם GEMINI_TTS_MODEL)
const DEFAULT_TTS_MODEL = process.env.GEMINI_TTS_MODEL || TTS_MODELS[1];

// ----- Handler -----
exports.handler = async (event, context) => {
  // מתודות מותרות
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // מפתח API
  if (!process.env.GEMINI_API_KEY) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'API key not configured' })
    };
  }

  // פירוק גוף הבקשה
  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Invalid JSON in request body', details: e.message })
    };
  }

  // ולידציות בסיסיות
  const text = requestBody.text;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Valid text is required' })
    };
  }

  // פרמטרים אופציונליים
  const voiceName = requestBody.voiceName || 'Kore';

  // תמיכה ב-multiSpeaker כמו בקוד שלך (לא חובה להשתמש)
  const multiSpeaker = !!requestBody.multiSpeaker;
  const speakerConfigs = Array.isArray(requestBody.speakerConfigs) ? requestBody.speakerConfigs : [];

  const temperature = clamp(requestBody.temperature ?? 0.7, 0.0, 2.0);
  const topP        = clamp(requestBody.topP ?? 0.9, 0.0, 1.0);
  const topK        = clamp(requestBody.topK ?? 40, 1, 100);
  const maxOutputTokens = clamp(requestBody.maxOutputTokens ?? 8192, 1, 32768);

  // בחירת מודל מבוקש מול whitelist
  const requestedModel = typeof requestBody.model === 'string' ? requestBody.model.trim() : '';
  const primaryModel = TTS_MODELS.includes(requestedModel) ? requestedModel : DEFAULT_TTS_MODEL;

  // speechConfig (יחיד/רב-דוברים)
  let speechConfig;
  if (multiSpeaker && speakerConfigs.length > 0) {
    speechConfig = {
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs: speakerConfigs.map(cfg => ({
          speaker: cfg.speaker,
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: cfg.voiceName || 'Kore' }
          }
        }))
      }
    };
  } else {
    speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName }
      }
    };
  }

  // ניסיון יצירה עם fallback + כיבוד Retry-After
  let result;
  try {
    result = await tryModelsSequentially({
      text,
      model: primaryModel,
      speechConfig,
      temperature,
      topP,
      topK,
      maxOutputTokens
    });
  } catch (e) {
    const status = e.status || 502;
    if (status === 429) {
      return {
        statusCode: 429,
        headers: corsHeaders(),
        body: JSON.stringify({
          error: 'quota_exceeded',
          details: e.message,
          retryAfterSeconds: e.retryAfterSeconds ?? undefined,
          timestamp: new Date().toISOString()
        })
      };
    }
    return {
      statusCode: 502,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: 'tts_failed',
        details: e.message,
        timestamp: new Date().toISOString()
      })
    };
  }

  const { audioBase64, modelUsed } = result;
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
};

// ----- Fallback + Backoff עם כיבוד Retry-After -----
async function tryModelsSequentially({
  text, model, speechConfig, temperature, topP, topK, maxOutputTokens
}) {
  const candidates = [model, ...TTS_MODELS.filter(m => m !== model)];

  // פרמטרי backoff
  const perModelMaxRetries = 2;     // כמה ניסיונות לכל מודל (מעבר לנסיון הראשון)
  const baseDelayMs = 600;          // בסיס ל-backoff
  const maxDelayMs = 8000;          // תקרת backoff

  // נאסוף את המינימום של Retry-After מכל ה-429 שנתקלנו בהם
  let minRetryAfterSec = Infinity;
  let lastErr = null;
  let lastStatus = null;

  for (const m of candidates) {
    // נסיון ראשון + רטריים עם backoff
    for (let attempt = 0; attempt <= perModelMaxRetries; attempt++) {
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

        lastStatus = response.status;

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          // 429 — נכבד Retry-After אם קיים
          if (response.status === 429) {
            const ra = parseRetryAfterSeconds(response.headers.get('retry-after'));
            if (Number.isFinite(ra)) {
              minRetryAfterSec = Math.min(minRetryAfterSec, ra);
            }
            // ננסה backoff קצר פעם-פעמיים על אותו מודל (אם הוגדר perModelMaxRetries)
            if (attempt < perModelMaxRetries) {
              const waitMs = computeDelay(attempt, baseDelayMs, maxDelayMs, ra);
              await sleep(waitMs);
              continue; // נסיון חוזר על אותו מודל
            }
            // סיימנו רטריים למודל הזה → נשבור ללופ הבא (fall back למודל הבא)
            lastErr = new Error(`429 quota exceeded for model ${m}`);
            break;
          }

          // שגיאות אחרות — נתקדם למודל הבא לאחר שננסה רטריים מוגבלים
          lastErr = new Error(`Gemini API error ${response.status} on ${m}: ${truncate(errText, 500)}`);
          if (attempt < perModelMaxRetries) {
            const waitMs = computeDelay(attempt, baseDelayMs, maxDelayMs);
            await sleep(waitMs);
            continue;
          }
          break;
        }

        // OK
        const data = await response.json();
        const audioBase64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!audioBase64) {
          lastErr = new Error(`No audio data in response from ${m}`);
          // אפשר נסיון נוסף קצר, ואז מעבר למודל הבא
          if (attempt < perModelMaxRetries) {
            const waitMs = computeDelay(attempt, baseDelayMs, maxDelayMs);
            await sleep(waitMs);
            continue;
          }
          break;
        }

        // הצלחה
        return { audioBase64, modelUsed: m };

      } catch (err) {
        lastErr = err;
        // רשת/פרסינג — ננסה רטרי קצר ואז נמשיך
        if (attempt < perModelMaxRetries) {
          const waitMs = computeDelay(attempt, baseDelayMs, maxDelayMs);
          await sleep(waitMs);
          continue;
        }
        // נגמרו הנסיונות על המודל הזה
        break;
      }
    }
    // נמשיך למודל הבא ב-fallback
  }

  // אם כל המודלים כשלו
  if (minRetryAfterSec !== Infinity || lastStatus === 429) {
    const e = new Error('All TTS models quota-exceeded (429).');
    e.status = 429;
    if (minRetryAfterSec !== Infinity) e.retryAfterSeconds = Math.max(1, Math.floor(minRetryAfterSec));
    throw e;
  }

  const e = lastErr || new Error('TTS failed for all models.');
  e.status = lastStatus || 502;
  throw e;
}

// ----- Utilities -----
function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function computeDelay(attempt, baseMs, maxMs, retryAfterSec) {
  // אם יש Retry-After – נכבד, עד תקרה סבירה
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    // לא נישן מעל 15 שניות כדי לא לחסום את הפונקציה יותר מדי
    return Math.min(retryAfterSec * 1000, 15000);
  }
  // אחרת backoff אקספוננציאלי + jitter
  const exp = baseMs * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(exp + jitter, maxMs);
}

function parseRetryAfterSeconds(headerVal) {
  if (!headerVal) return NaN;
  // לרוב מחזירים שניות. אם תאריך – נחזיר ההפרש בזמן (נתעלם כאן לשמירה על פשטות)
  const n = Number(headerVal);
  if (Number.isFinite(n)) return n;
  const dateMs = Date.parse(headerVal);
  if (Number.isFinite(dateMs)) {
    const diff = Math.ceil((dateMs - Date.now()) / 1000);
    return diff > 0 ? diff : NaN;
  }
  return NaN;
}

function truncate(s, maxLen) {
  if (!s || typeof s !== 'string') return '';
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

// המרת PCM ➝ WAV
function pcmToWav(pcmBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const length = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + length);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + length, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);                // PCM subchunk size
  buffer.writeUInt16LE(1, 20);                 // audio format = PCM
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
