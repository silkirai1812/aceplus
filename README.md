# ACEplus — India-aware Spoken English Coach

An EdTech app that teaches spoken English to Indian students via AI scoring and roleplay scenarios. Uses Sarvam AI (Indian English STT/TTS) and Gemini 2.5 Flash for feedback — never penalises Indian accent features.

## Features

- 🎤 **Voice recording** with live waveform
- 🤖 **India-aware scoring** — accepts colour, centre, maths; flags only genuine errors
- 📊 **Animated score rings** — Overall, Pronunciation, Grammar, Fluency
- 🔤 **Word chips** — green (correct), amber (Indian variant), red (error with tooltip)
- 🎭 **AI Roleplay** — practice with an interviewer, doctor, or shopkeeper
- 🔊 **Sarvam TTS** — feedback read aloud in Indian English (Ritu voice)
- 📜 **Session history** — last 10 attempts tracked

## Quick Start

### Backend

```bash
cd backend
cp .env.example .env
# Add your keys to .env
npm install
npm start
# Runs on http://localhost:10000
```

### Frontend

Open `frontend/public/index.html` directly in a browser, or serve it:
```bash
cd frontend/public
npx serve .
# Open http://localhost:3000
```

Enter your API keys in the UI (stored in localStorage). No build step needed.

## API Keys (both free)

| Service | Get key | Free tier |
|---------|---------|-----------|
| Sarvam AI | https://console.sarvam.ai | 60 min STT/month |
| Gemini 2.5 Flash | https://aistudio.google.com/apikey | 1,500 req/day |

## Deployment (Render.com)

1. Push to GitHub
2. Connect repo to Render — it reads `render.yaml` automatically
3. Set env vars in Render dashboard: `SARVAM_API_KEY`, `GEMINI_API_KEY`, `FRONTEND_URL`
4. After deploy: update `const BACKEND = '...'` in `index.html` to your Render backend URL
5. Redeploy frontend

## Architecture

```
Student mic → MediaRecorder (webm)
  → POST /api/transcribe → Sarvam STT (saarika:v2, en-IN)
  → transcript → rule-based scoring (pron/gram/flu/vocab)
  → POST /api/score → Gemini 2.5 Flash → feedback JSON
  → Sarvam TTS (bulbul:v3, ritu) → WAV base64
  → frontend plays audio + renders chips/rings/bars/cards

AI Roleplay:
Student mic → Sarvam STT → POST /api/roleplay → Gemini (in-character)
  → Sarvam TTS → character speaks → loop
```

## Scoring Logic

- **Pronunciation**: ratio of correctly-pronounced words; `KNOWN_ERRORS` map catches common Indian mispronunciations
- **Grammar**: detects present-continuous overuse (`"am having"`, `"am knowing"`)
- **Fluency**: word count ratio vs target sentence
- **Vocabulary**: lexical diversity (unique/total words)
- **Indian variants**: `colour`, `centre`, `behaviour`, `maths` etc. — accepted, never penalised

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/transcribe` | Sarvam STT — returns transcript |
| POST | `/api/score` | Rule scoring + Gemini feedback + TTS |
| POST | `/api/roleplay` | AI character conversation + TTS |
| GET  | `/api/health` | Key presence check |

Keys can be passed as `x-sarvam-key` / `x-gemini-key` headers (frontend) or set as env vars (production).
