import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import FormData from 'form-data';
import fetch from 'node-fetch';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── CORS ───────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://aceplus-frontend.onrender.com',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:5500',
  'null',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// ─── KEY HELPERS ─────────────────────────────────────────────────────────────
function getSarvamKey(req) { return process.env.SARVAM_API_KEY || req.headers['x-sarvam-key'] || ''; }
function getGroqKey(req) { return process.env.GROQ_API_KEY || req.headers['x-groq-key'] || ''; }

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';
const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const SPEECHACE_URL = 'https://api5.speechace.com/api/scoring/text/v9/json';

// ─── LANGUAGE DETECTION ──────────────────────────────────────────────────────
const HINDI_MARKERS = new Set([
  'mera', 'meri', 'tera', 'teri', 'aap', 'tum', 'main', 'hum', 'yeh', 'woh', 'kya',
  'hai', 'hain', 'tha', 'thi', 'the', 'ka', 'ki', 'ke', 'se', 'ko', 'mein', 'par',
  'aur', 'ya', 'nahi', 'haan', 'kab', 'kahan', 'kaisa', 'kyun', 'achha', 'bahut',
  'bilkul', 'zaroor', 'phir', 'abhi', 'kal', 'aaj', 'naam', 'ghar', 'paani',
  'khana', 'dost', 'bhai', 'behen', 'matlab', 'thoda', 'zyada', 'sirf', 'bas',
  'toh', 'lekin', 'kyunki', 'apna', 'apni', 'unka', 'unki', 'tumhara', 'hamara',
  'isko', 'usko', 'inhe', 'unhe', 'yahan', 'wahan', 'idhar', 'udhar',
]);

function detectNonEnglish(transcript) {
  const words = transcript.toLowerCase().split(/\s+/);
  const hindiWords = words.filter(w => HINDI_MARKERS.has(w.replace(/[^a-z]/g, '')));
  if (hindiWords.length >= 2) return hindiWords;
  return null;
}

// ─── SARVAM TTS HELPER ───────────────────────────────────────────────────────
async function sarvamTTS(text, key, lang = 'hi-IN') {
  const speaker = lang === 'en-IN' ? 'ritu' : 'priya';
  const res = await fetch(SARVAM_TTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-subscription-key': key || process.env.SARVAM_API_KEY || '',
    },
    body: JSON.stringify({
      inputs: [text],
      target_language_code: lang,
      speaker,
      model: 'bulbul:v3',
      pace: 0.95,
      enable_preprocessing: true,
    }),
  });
  if (!res.ok) throw new Error(`Sarvam TTS error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.audios?.[0] ?? null;
}

// ─── SPEECHACE HELPER ────────────────────────────────────────────────────────
// Calls SpeechAce and returns clean word/phoneme scores + fluency data
// audioBuffer: Buffer of the audio file
// target: the sentence the student was supposed to say
async function scoreSpeechAce(audioBuffer, mimeType, target) {
  const speechaceKey = process.env.SPEECHACE_API_KEY;
  if (!speechaceKey) return null; // gracefully skip if key not set

  try {
    const form = new FormData();
    form.append('user_audio_file', audioBuffer, {
      filename: 'audio.webm',
      contentType: mimeType || 'audio/webm',
    });
    form.append('text', target);
    form.append('include_fluency', '1');

    const res = await fetch(
      `${SPEECHACE_URL}?key=${speechaceKey}&dialect=en-us&user_id=aceready_user`,
      {
        method: 'POST',
        headers: { ...form.getHeaders() },
        body: form,
      }
    );

    if (!res.ok) {
      console.error('SpeechAce HTTP error:', res.status);
      return null;
    }

    const data = await res.json();
    if (data.status !== 'success') {
      console.error('SpeechAce API error:', data.detail_message);
      return null;
    }

    // Extract word scores — find words that scored below 80 (need work)
    const wordScores = data.text_score?.word_score_list?.map(w => ({
      word: w.word,
      score: w.quality_score,
      // Find the weakest phoneme in this word
      weakestPhone: w.phone_score_list?.reduce((worst, p) =>
        (!worst || p.quality_score < worst.quality_score) ? p : worst
        , null),
    })) || [];

    const weakWords = wordScores.filter(w => w.score < 80);
    const goodWords = wordScores.filter(w => w.score >= 90);

    return {
      pronunciationScore: data.text_score?.speechace_score?.pronunciation ?? null,
      fluencyScore: data.text_score?.speechace_score?.fluency ?? null,
      ielts: data.text_score?.ielts_score ?? null,
      cefr: data.text_score?.cefr_score ?? null,
      wordScores,
      weakWords,   // words that need improvement
      goodWords,   // words pronounced well
      fluencyDetail: {
        speechRate: data.text_score?.fluency?.overall_metrics?.speech_rate ?? null,
        pauseCount: data.text_score?.fluency?.overall_metrics?.all_pause_count ?? null,
        pauseDuration: data.text_score?.fluency?.overall_metrics?.all_pause_duration ?? null,
        wordsPerMin: data.text_score?.fluency?.overall_metrics?.word_correct_per_minute ?? null,
      },
    };
  } catch (err) {
    console.error('SpeechAce call failed:', err.message);
    return null; // non-fatal — app still works without SpeechAce
  }
}

// ─── POST /api/transcribe ────────────────────────────────────────────────────
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
    const sarvamKey = getSarvamKey(req);
    if (!sarvamKey) return res.status(400).json({ error: 'Sarvam API key not provided' });

    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: 'audio.webm',
      contentType: req.file.mimetype || 'audio/webm',
    });
    form.append('language_code', 'en-IN');
    form.append('model', 'saarika:v2.5');

    const sarvamRes = await fetch(SARVAM_STT_URL, {
      method: 'POST',
      headers: {
        'api-subscription-key': sarvamKey,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!sarvamRes.ok) {
      const errText = await sarvamRes.text();
      console.error('Sarvam STT error:', errText);
      return res.status(502).json({ error: 'STT service error', details: errText });
    }

    const data = await sarvamRes.json();
    const transcript = data.transcript ?? '';
    const hindiWords = detectNonEnglish(transcript);
    res.json({
      transcript,
      confidence: data.confidence ?? null,
      engine: 'sarvam-saarika-v2',
      languageWarning: hindiWords
        ? `Please speak in English. Detected non-English words: ${hindiWords.join(', ')}`
        : null,
    });
  } catch (err) {
    console.error('/api/transcribe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/score ─────────────────────────────────────────────────────────
// Now accepts optional audioBuffer for SpeechAce scoring
// Frontend sends audio as base64 in the JSON body alongside transcript
app.post('/api/score', async (req, res) => {
  try {
    const {
      transcript, target, pronScore, gramScore, fluScore, vocabScore,
      badWords, okWords, ttsLang = 'hi-IN',
      audioBase64: clientAudioBase64,
      audioMime,
      forceLang,
    } = req.body;

    // ── FAST PATH: language switch only — just regenerate spoken_summary in new language ──
if (forceLang) {
  const langPrompt = `Write ONLY 2-3 warm encouraging sentences in ${
  ttsLang === 'hi-IN' ? 'Hindi using Devanagari script only — example: आपने बहुत अच्छा बोला! अंग्रेज़ी में और अभ्यास करते रहो!'
  : ttsLang === 'bn-IN' ? 'Bengali using Bengali script only — example: তুমি খুব সুন্দরভাবে কথা বলেছ! ইংরেজিতে আরও অনুশীলন করতে থাকো!'
  : ttsLang === 'gu-IN' ? 'Gujarati using Gujarati script only — example: તમે ખૂબ સારું બોલ્યા! અંગ્રેજીમાં વધુ અભ્યાસ કરતા રહો!'
  : 'clear warm English — example: Great effort! Keep practicing your English every day!'
} to be read aloud to a student who just practiced spoken English. Be warm and encouraging. Write ONLY the sentences, nothing else.`;

  const groqKey = getGroqKey(req);
  const sarvamKey = getSarvamKey(req);

  const groqRes = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${groqKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: langPrompt }],
      temperature: 0.7,
      max_tokens: 200,
    }),
  });

  const groqData = await groqRes.json();
  const spokenText = groqData.choices?.[0]?.message?.content?.trim() || '';

  let audioBase64 = null;
  try {
    audioBase64 = await sarvamTTS(spokenText, sarvamKey, ttsLang);
  } catch(e) {
    console.warn('TTS failed on lang switch:', e.message);
  }

  return res.json({ feedback: null, audioBase64, spokenText, speechaceData: null });
}

    if (!transcript) return res.status(400).json({ error: 'transcript required' });
    const groqKey = getGroqKey(req);
    if (!groqKey) return res.status(400).json({ error: 'Groq API key not provided' });
    const sarvamKey = getSarvamKey(req);

    // ── SPEECHACE SCORING (runs in parallel with prompt building) ────────────
    let saData = null;
    if (clientAudioBase64) {
      // Only call SpeechAce in Scoring Mode where we have a target sentence
      // Use transcript as target for free speech scenarios so SpeechAce scores pronunciation accurately
      const speechaceTarget = (target && target.trim()) ? target : transcript;
      if (clientAudioBase64 && speechaceTarget) {
        const audioBuffer = Buffer.from(clientAudioBase64, 'base64');
        saData = await scoreSpeechAce(audioBuffer, audioMime || 'audio/webm', speechaceTarget);
      }
    }
    // SpeechAce fluency is unreliable for short free-speech — fallback to frontend score
    if (saData && (saData.fluencyScore === 0 || saData.fluencyScore === null)) {
      saData.fluencyScore = fluScore;
    }

    // ── WORD-BY-WORD TRANSCRIPT ANALYSIS ────────────────────────────────────
    const targetWords = (target || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
    const spokenWords = transcript.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);

    const missingWords = targetWords.filter(w => !spokenWords.includes(w));
    const extraWords = spokenWords.filter(w => !targetWords.includes(w));

    const FILLERS = ['um', 'uh', 'er', 'ah', 'like', 'basically', 'actually', 'so', 'you know'];
    const fillersUsed = spokenWords.filter(w => FILLERS.includes(w));

    const wordCountDiff = spokenWords.length - targetWords.length;
    const wordCountNote = target
      ? wordCountDiff < -3 ? `Student spoke ${Math.abs(wordCountDiff)} fewer words than expected — response too short`
        : wordCountDiff > 5 ? `Student added ${wordCountDiff} extra words — possible repetition or rambling`
          : 'Word count is appropriate'
      : `Student spoke ${spokenWords.length} words`;

    const repetitions = [];
    for (let i = 0; i < spokenWords.length - 1; i++) {
      if (spokenWords[i] === spokenWords[i + 1]) repetitions.push(spokenWords[i]);
    }

    const overall = Math.round((pronScore + gramScore + fluScore + vocabScore) / 4);

    // ── BUILD GROQ PROMPT ────────────────────────────────────────────────────
    // If SpeechAce data is available, include it for richer feedback
    const speechaceSection = saData ? `
SPEECHACE PRONUNCIATION DATA (real phoneme-level analysis):
- Pronunciation score: ${saData.pronunciationScore}/100
- Fluency score: ${saData.fluencyScore}/100
- IELTS equivalent: Pronunciation ${saData.ielts?.pronunciation}/9, Fluency ${saData.ielts?.fluency}/9
- CEFR level: Pronunciation ${saData.cefr?.pronunciation}, Fluency ${saData.cefr?.fluency}
- Words needing improvement (scored below 80): ${saData.weakWords.length ? saData.weakWords.map(w => `"${w.word}" (${w.score}%)${w.weakestPhone ? ` — weakest sound: "${w.weakestPhone.phone}"` : ''}`).join(', ') : 'none — all words pronounced well'}
- Speech rate: ${saData.fluencyDetail.wordsPerMin ? Math.round(saData.fluencyDetail.wordsPerMin) + ' words/min' : 'unknown'}
- Pauses detected: ${saData.fluencyDetail.pauseCount ?? 'unknown'} pauses totalling ${saData.fluencyDetail.pauseDuration ?? '?'} seconds
` : `
SPEECHACE DATA: Not available for this attempt (no target sentence or audio not provided).
Use transcript analysis below as the basis for pronunciation feedback.
`;

    const userPrompt = `
You are evaluating a student's spoken English response.

SCENARIO CONTEXT (what the student was asked to do — NOT a script they must follow word for word): "${target || '(free speech)'}"
STUDENT ACTUALLY SAID: "${transcript}"

FRONTEND SCORES (0-100):
- Pronunciation: ${pronScore} (unreliable — use SpeechAce data below if available)
- Grammar: ${gramScore}
- Fluency: ${fluScore}
- Vocabulary: ${vocabScore}
- Overall: ${overall}
${speechaceSection}
TRANSCRIPT ANALYSIS:
- Filler words used: ${fillersUsed.length ? fillersUsed.join(', ') : 'none'}
- Repeated words (stammers): ${repetitions.length ? repetitions.join(', ') : 'none'}
- ${wordCountNote}
- Mispronounced words (basic check): ${badWords?.length ? badWords.join(', ') : 'none'}

INSTRUCTIONS:
- Write as a warm human English teacher talking directly to the student — NOT as an AI giving a technical report
- NEVER mention any numbers from scores in feedback text — no "47/100", no "score is 60", no "pronunciation score", no "vocabulary score", no "fluency score" — never quote any number from the scoring data
- NEVER say "the prompt", "key words from the prompt", "the target sentence", "the scenario" — students don't know these exist
- NEVER use technical words like "filler words", "transcript", "fluency score", "vocabulary score", "CEFR", "IELTS"
- NEVER list specific words the student missed — the scenario context is just for your understanding, not a required script
- If SpeechAce flagged a weak word, mention it naturally — say "try saying the word 'name' a little more clearly" not "word 'name' scored 47%"
- If fluency is low, say it in simple terms — "try to speak a little faster and more smoothly" not "fluency score is 0 due to speech rate of 8 words/min"
- If student stammered or repeated words, mention it like a teacher would — "I noticed you repeated yourself a couple of times, try to speak one thought at a time"
- Feedback should sound like a teacher saying it out loud to a child — warm, encouraging, specific
- For young Indian students — be specific about what to practice next

Respond with ONLY valid JSON (no markdown):
{
  "summary": "2-3 sentences referencing specific words or scores from the data above",
  "strengths": ["specific strength with example from their actual speech"],
  "improvements": ["specific issue with word/score as evidence"],
  "encouragement": "one warm closing sentence",
  "spoken_summary": "2-3 warm sentences in ${ttsLang === 'hi-IN' ? 'Hindi using Devanagari script only' : ttsLang === 'bn-IN' ? 'Bengali using Bengali script only' : ttsLang === 'gu-IN' ? 'Gujarati using Gujarati script only — example: તમે ખૂબ સારું બોલ્યા! અંગ્રેજીમાં વધુ અભ્યાસ કરતા રહો!' : 'clear warm English'} to be read aloud"
}`;

    // ── CALL GROQ ────────────────────────────────────────────────────────────
    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: 'system',
            content: `You are an honest and warm English pronunciation coach for Indian school students.
You deeply understand Indian English phonology: retroflex consonants, v/w substitution, vowel-length collapse, dental vs alveolar stops, and present-continuous overuse.
NEVER penalise Indian accent features — only flag things that cause genuine miscommunication.
Accept standard Indian English spellings: colour, centre, behaviour, maths, programme.
When SpeechAce data is provided, trust it over your own assumptions about pronunciation.
Be honest — accurate feedback helps students improve more than empty praise.`,
          },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 1024,
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq error:', errText);
      return res.status(502).json({ error: 'LLM service error', details: errText });
    }

    const groqData = await groqRes.json();
    const rawText = groqData.choices?.[0]?.message?.content ?? '{}';

    let feedback;
    try {
      const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      feedback = JSON.parse(clean);
    } catch {
      feedback = {
        summary: rawText,
        strengths: [],
        improvements: [],
        encouragement: '',
        spoken_summary: rawText.slice(0, 200),
      };
    }

    // ── TTS ──────────────────────────────────────────────────────────────────
    let audioBase64 = null;
    const spokenText = feedback.spoken_summary || feedback.summary || '';
    try {
      audioBase64 = await sarvamTTS(spokenText, sarvamKey, ttsLang);
    } catch (ttsErr) {
      console.warn('TTS failed (non-fatal):', ttsErr.message);
    }

    // ── RESPONSE — includes speechaceData for frontend comparison panel ──────
    res.json({
      feedback,
      audioBase64,
      spokenText,
      speechaceData: saData ? {
        pronunciationScore: saData.pronunciationScore,
        fluencyScore: saData.fluencyScore,
        ielts: saData.ielts,
        cefr: saData.cefr,
        wordScores: saData.wordScores,
        weakWords: saData.weakWords,
        fluencyDetail: saData.fluencyDetail,
      } : null,
    });

  } catch (err) {
    console.error('/api/score error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/speechace-score (standalone endpoint for direct testing) ──────
app.post('/api/speechace-score', upload.single('audio'), async (req, res) => {
  try {
    const speechaceKey = process.env.SPEECHACE_API_KEY;
    if (!speechaceKey) return res.status(400).json({ error: 'SpeechAce API key not configured' });

    const target = req.body.target;
    if (!target) return res.status(400).json({ error: 'target text required' });
    if (!req.file) return res.status(400).json({ error: 'audio file required' });

    const saData = await scoreSpeechAce(req.file.buffer, req.file.mimetype, target);
    if (!saData) return res.status(502).json({ error: 'SpeechAce scoring failed' });

    res.json(saData);
  } catch (err) {
    console.error('/api/speechace-score error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/roleplay ───────────────────────────────────────────────────────
app.post('/api/roleplay', async (req, res) => {
  try {
    const { transcript, scenario, history = [] } = req.body;
    if (!transcript) return res.status(400).json({ error: 'transcript required' });
    const groqKey = getGroqKey(req);
    if (!groqKey) return res.status(400).json({ error: 'Groq API key not provided' });
    const sarvamKey = getSarvamKey(req);

    const SCENARIOS = {
      interview: {
        role: 'a friendly class teacher',
        context: 'an oral class presentation where a student presents about their favourite topic',
        instruction: 'Ask one simple question at a time. Be encouraging and patient. React warmly to the student\'s answers.',
      },
      doctor: {
        role: 'a curious classmate',
        context: 'a science project discussion between two students',
        instruction: 'Ask about the project one question at a time. Be excited and curious. Use simple school-level language.',
      },
      shopping: {
        role: 'a helpful school librarian',
        context: 'a student visiting the school library to borrow a book',
        instruction: 'Help the student find a book. Ask about their reading interests. Keep it friendly and fun.',
      },
      custom: {
        role: 'a friendly English practice buddy',
        context: 'a casual conversation about school life, hobbies, or favourite subjects',
        instruction: 'Have a natural, fun conversation. Ask about school, friends, hobbies, or favourite subjects. Gently encourage the student to say more.',
      },
    };

    const sc = SCENARIOS[scenario] || SCENARIOS.custom;

    const systemPrompt = `You are ${sc.role} in a ${sc.context}.
${sc.instruction}
Keep your responses SHORT — maximum 2-3 sentences plus one simple follow-up question.
Use simple, clear English suitable for school students aged 10-16. Do not correct grammar directly — just model good English naturally.
Be warm, patient, and encouraging. Do not break character. Do not add stage directions or descriptions.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({ role: h.role === 'model' ? 'assistant' : h.role, content: h.text })),
      { role: 'user', content: transcript },
    ];

    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.85,
        max_tokens: 512,
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return res.status(502).json({ error: 'LLM service error', details: errText });
    }

    const groqData = await groqRes.json();
    const reply = groqData.choices?.[0]?.message?.content?.trim() ?? "I didn't catch that, could you repeat?";

    let audioBase64 = null;
    try {
      audioBase64 = await sarvamTTS(reply, sarvamKey);
    } catch (ttsErr) {
      console.warn('TTS failed (non-fatal):', ttsErr.message);
    }

    res.json({ reply, audioBase64 });
  } catch (err) {
    console.error('/api/roleplay error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health ──────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const sarvam = !!process.env.SARVAM_API_KEY;
  const groq = !!process.env.GROQ_API_KEY;
  const speechace = !!process.env.SPEECHACE_API_KEY;
  res.json({
    status: sarvam && groq ? 'ok' : 'degraded',
    sarvam,
    groq,
    speechace,
    timestamp: new Date().toISOString(),
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`ACEplus backend running on port ${PORT}`));