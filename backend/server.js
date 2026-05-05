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

// ─── KEY HELPER ──────────────────────────────────────────────────────────────
// Keys can come from env vars (server) OR request headers (client-side entry)
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

// ─── HELPERS ────────────────────────────────────────────────────────────────
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

// ─── POST /api/speechace-score ───────────────────────────────────────────────
app.post('/api/speechace-score', upload.single('audio'), async (req, res) => {
  try {
    const speechaceKey = process.env.SPEECHACE_API_KEY;
    if (!speechaceKey) return res.status(400).json({ error: 'SpeechAce API key not configured' });

    const target = req.body.target;
    if (!target) return res.status(400).json({ error: 'target text required' });
    if (!req.file) return res.status(400).json({ error: 'audio file required' });

    const form = new FormData();
    form.append('user_audio_file', req.file.buffer, {
      filename: 'audio.webm',
      contentType: req.file.mimetype || 'audio/webm',
    });
    form.append('text', target);
    form.append('include_fluency', '1');

    const speechaceRes = await fetch(
      `${SPEECHACE_URL}?key=${speechaceKey}&dialect=en-us&user_id=aceready_user`,
      {
        method: 'POST',
        headers: { ...form.getHeaders() },
        body: form,
      }
    );

    if (!speechaceRes.ok) {
      const errText = await speechaceRes.text();
      console.error('SpeechAce error:', errText);
      return res.status(502).json({ error: 'SpeechAce error', details: errText });
    }

    const data = await speechaceRes.json();

    // Extract what we need cleanly
    const wordScores = data.text_score?.word_score_list?.map(w => ({
      word: w.word,
      score: w.quality_score,
      phonemes: w.phone_score_list?.map(p => ({
        phone: p.phone,
        score: p.quality_score,
        soundedLike: p.sound_most_like,
      })) || [],
    })) || [];

    const overall = data.text_score?.speechace_score ?? null;
    const ielts = data.text_score?.ielts_score ?? null;
    const cefr = data.text_score?.cefr_score ?? null;
    const fluency = data.text_score?.fluency ?? null;

    res.json({
      wordScores,
      overall,
      ielts,
      cefr,
      fluency,
      raw: data, // full response for debugging
    });

  } catch (err) {
    console.error('/api/speechace-score error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/score ─────────────────────────────────────────────────────────
app.post('/api/score', async (req, res) => {
  try {
    const { transcript, target, pronScore, gramScore, fluScore, vocabScore, badWords, okWords, ttsLang = 'hi-IN' } = req.body;
    if (!transcript) return res.status(400).json({ error: 'transcript required' });
    const groqKey = getGroqKey(req);
    if (!groqKey) return res.status(400).json({ error: 'Groq API key not provided' });
    const sarvamKey = getSarvamKey(req);

    const overall = Math.round((pronScore + gramScore + fluScore + vocabScore) / 4);

    // Analyse word-by-word differences between target and transcript
    const targetWords = (target || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
    const spokenWords = transcript.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);

    // Find missing words (in target but not spoken)
    const missingWords = targetWords.filter(w => !spokenWords.includes(w));

    // Find extra words (spoken but not in target) — catches stammers, fillers
    const extraWords = spokenWords.filter(w => !targetWords.includes(w));

    // Find filler words
    const FILLERS = ['um', 'uh', 'er', 'ah', 'like', 'basically', 'actually', 'so', 'you know'];
    const fillersUsed = spokenWords.filter(w => FILLERS.includes(w));

    // Word count comparison
    const wordCountDiff = spokenWords.length - targetWords.length;
    const wordCountNote = target
      ? wordCountDiff < -3 ? `Student spoke ${Math.abs(wordCountDiff)} fewer words than expected — response too short`
        : wordCountDiff > 5 ? `Student added ${wordCountDiff} extra words — possible repetition or rambling`
          : 'Word count is appropriate'
      : `Student spoke ${spokenWords.length} words`;

    // Sentence structure check — detect repetitions
    const words = spokenWords;
    const repetitions = [];
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i] === words[i + 1]) repetitions.push(words[i]);
    }

    const userPrompt = `
You are evaluating a student's spoken English response.

SCENARIO CONTEXT (what the student was asked to do — this is a situation, NOT a script they must follow word for word): "${target || '(free speech)'}"
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
- NEVER mention score numbers in feedback (no "your vocabulary score was 57")
- NEVER say "the prompt", "key words from the prompt", "the target sentence" — students don't know these exist
- NEVER use technical words like "filler words", "transcript", "fluency score", "vocabulary score"
- NEVER list specific words the student missed from the scenario context
- The scenario context is just for your understanding of what situation the student was in — do not treat it as a required script
- Instead of "you used filler words like 'like'" → say "try to speak without pausing to say 'like' in between your sentences"
- Instead of "you missed key words" → say "try to give more detail about what you want" naturally
- If student stammered or repeated words, mention it naturally like a teacher would
- If fluency is low, say it in simple terms — "try to speak a little faster and more smoothly"
- Feedback should sound like a teacher saying it out loud to a child, warm and encouraging
- For young Indian students — be specific about what to practice next, not what they did wrong

Respond with ONLY valid JSON (no markdown):
{
  "summary": "2-3 sentences written like a teacher talking to the student directly",
  "strengths": ["one specific thing they did well, described naturally"],
  "improvements": ["one specific thing to practice, described like a teacher would say it"],
  "encouragement": "one warm closing sentence",
  "spoken_summary": "2-3 warm sentences in ${ttsLang === 'hi-IN' ? 'Hindi using Devanagari script only — example: आपने बहुत अच्छा बोला! अंग्रेज़ी में और अभ्यास करते रहो, आप ज़रूर आगे बढ़ोगे!' : ttsLang === 'bn-IN' ? 'Bengali using Bengali script only — example: তুমি খুব সুন্দরভাবে কথা বলেছ! ইংরেজিতে আরও অনুশীলন করতে থাকো, তুমি অবশ্যই এগিয়ে যাবে!' : 'clear warm English — example: Great effort today! Keep practicing your English every day and you will improve.'} to be read aloud to the student — make sure the language matches exactly"
}`;

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

SCORING RULES (be strict and accurate):
- Reserve 90+ only for near-native English with almost no errors.
- Score 70-89 for good English with minor accent/grammar issues.
- Score 50-69 for understandable English with noticeable errors.
- Score below 50 if the student mixed Hindi/other languages into the response, spoke mostly in another language, or has major comprehension-affecting errors.
- If non-English words were used, explicitly mention this in improvements.
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

    let audioBase64 = null;
    let spokenText = feedback.spoken_summary || feedback.summary || '';
    try {
      audioBase64 = await sarvamTTS(spokenText, sarvamKey, ttsLang);
    } catch (ttsErr) {
      console.warn('TTS failed (non-fatal):', ttsErr.message);
    }

    res.json({ feedback, audioBase64, spokenText });
  } catch (err) {
    console.error('/api/score error:', err);
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

    // TTS the character's reply
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
  res.json({
    status: sarvam && groq ? 'ok' : 'degraded',
    sarvam,
    groq,
    timestamp: new Date().toISOString(),
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`ACEplus backend running on port ${PORT}`));
