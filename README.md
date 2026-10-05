# Gakki — AI-Powered Cross-Platform Music & Voice Platform

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![Vite](https://img.shields.io/badge/Frontend-Vite%20%2B%20React-purple.svg)](https://vitejs.dev/)
[![Gemini 2.0 Live](https://img.shields.io/badge/AI%20Agent-Gemini%202.0%20Live-orange.svg)](https://deepmind.google/technologies/gemini/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Gakki** is an enterprise-grade, modular music and voice platform featuring seamless Discord playback, low-latency desktop audio output, Gemini Live-powered conversational voice interaction, intelligent AI DJ commentary, multi-track recording, and Google Meet conference audio integration.

---

## Key Features

### 🎧 Multi-Platform Audio Architecture
* **Discord Voice Pipeline:** High-fidelity Opus voice streaming with dynamic buffering, volume normalization, and queue management.
* **Desktop Audio Output:** Direct local PCM output with selectable hardware devices (Speakers, USB DACs, Headphones) and graceful disconnection fallback.
* **Virtual Audio Routing:** Native virtual cable detection (VB-Audio Virtual Cable, BlackHole, VoiceMeeter) allowing Gakki audio to route into conferencing software.
* **Unified Playback Manager:** Seamless target switching between `discord`, `desktop`, and `virtual` outputs without queue interruption or volume loss.

### 🎙️ Voice Command Engine & Gemini Live Voice Agent
* **Local Wake-Word Detection:** Privacy-first `"Hey Gakki"` / `"Gakki,"` acoustic envelope recognition running purely locally—**no continuous streaming to cloud APIs**.
* **Voice Activity Detection (VAD):** In-memory RMS energy and Zero-Crossing Rate (ZCR) filtering with silence hangover prevention.
* **Low-Latency Resampling:** 48 kHz $\to$ 16 kHz 16-bit mono PCM decimation for Gemini ingestion; 24 kHz $\to$ 48 kHz stereo upsampling for voice output.
* **Strict Intent Sandbox:** Conversational speech converted into verified structured intents (`PLAY_TRACK`, `PAUSE`, `SKIP`, `SMART_SHUFFLE`, `ENABLE_DJ`, etc.) validated against backend Discord/Desktop permission levels. Prohibits shell/file/database calls.
* **Barge-In Interruption:** AI voice output halts in $<10\text{ ms}$ upon detecting user vocal input.
* **Deterministic Fallback:** Instant ($<1\text{ ms}$) offline regex intent matcher if cloud connection drops.

### 🤖 AI DJ & Commentary Engine
* **Acoustic-Aware Transitions:** Energy-based BPM matching, key compatibility scoring, and smooth crossfades.
* **Factual Commentary Generation:** Generates concise, natural commentary based strictly on acoustic attributes without hallucinated facts.
* **Zero-Gap Asynchronous Pre-Generation:** Scripts and TTS audio are synthesized 30 seconds prior to transitions to ensure continuous, gap-free playback.
* **Modular TTS Registry:** Gemini Speech TTS (voices: *Puck, Aoede, Charon, Kore, Fenrir*) with deterministic offline synthetic fallback.
* **Commentary Mixer & Ducking:** Controlled $-12\text{ dB}$ music ducking with strict priority resolution (`User Speech > Playback Continuity > System Alerts > DJ Commentary`).

### 📹 Google Meet Conference Integration
* **Official Media API Client:** Consumes conference audio and participant metadata via Google Meet Media API (`v1alpha` Developer Preview).
* **Receive-Only Media Transport:** Explicitly models `sendAudio: false` in accordance with Google Meet Media API constraints.
* **Desktop Virtual Audio Send Path:** Routes Gakki playback through desktop virtual audio outputs (e.g. VB-Audio Cable) into Google Meet microphone input with zero API violations.

### 🎙️ Multi-Track Recording & Transcription (Phase 11)
* **Isolated Multi-Track Capture:** Per-participant audio stream recording with automatic time synchronization.
* **Whisper & Gemini Transcription:** Automatic speech-to-text with speaker diarization and meeting summary generation.

### 💻 Modern Glassmorphic Web Dashboard
* **Real-Time Control:** Live queue manipulation, synchronized lyrics, audio visualizer, and routing device selectors.
* **Voice & Meet Station:** Master privacy toggle (🎤 ON/OFF), wake-word indicator, voice simulator, and Google Meet integration panel.

---

## Monorepo Project Structure

```text
Gakki_MusicBot/
├── packages/
│   ├── core/           # Platform-agnostic music engine, audio DSP, VAD, DJ & types
│   │   ├── src/audio/          # Resamplers, VAD detector, wake-word detector
│   │   ├── src/dj/             # DJ text generator, TTS registry, commentary mixer
│   │   ├── src/voice/          # VoiceCommandEngine, VoiceResponseOutput, intent schemas
│   │   ├── src/managers/       # PlaybackManager, AudioRoutingManager, VoiceSessionManager
│   │   └── src/types/          # TypeScript interfaces for platform, audio, and voice
│   ├── server/         # Express REST API, WebSocket server, Discord bot, Meet adapter
│   │   ├── src/voice/          # Gemini Live persistent WebSocket provider
│   │   ├── src/meet/           # Google Meet OAuth service & MeetVoiceAdapter
│   │   ├── src/security/       # VoiceRateLimiter, permission validator
│   │   └── src/api/            # REST endpoints for audio, voice, meet, and queue
│   ├── web/            # React 18 + Vite + Tailwind/Glassmorphic dashboard
│   │   ├── src/components/     # VoiceCommandSection, AudioRoutingSection, Visualizer
│   │   └── src/services/       # REST and WebSocket client state synchronization
│   └── desktop/        # Electron / Native Windows executable packaging
├── PHASE_12_VERIFICATION_REPORT.md  # Desktop audio architecture verification report
├── PHASE_13_VERIFICATION_REPORT.md  # Voice commands, Gemini & Meet verification report
└── package.json        # Workspace configuration and unified scripts
```

---

## Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) $\ge 20.0.0$
- [Docker](https://www.docker.com/) (for PostgreSQL database)
- A [Discord Bot Token](https://discord.com/developers/applications)
- A [Google Gemini API Key](https://aistudio.google.com/) (for Gemini Live & AI DJ features)

### 1. Installation

```bash
# Clone the repository
git clone https://github.com/ady6615/Gakki.git
cd Gakki

# Install dependencies across all workspace packages
npm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env` and configure your credentials:

```bash
cp .env.example .env
```

```env
# Discord Configuration
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_client_id

# Google Gemini AI Configuration (Voice Agent & AI DJ TTS)
GEMINI_API_KEY=your_gemini_api_key
GEMINI_LIVE_MODEL=gemini-2.0-flash
AI_DJ_DEFAULT_VOICE=Puck
DJ_COMMENTARY_COOLDOWN_SECONDS=180

# Server & Database Configuration
PORT=3000
DATABASE_URL=postgresql://gakki:gakki_secret@localhost:5432/gakki_db
JWT_SECRET=your_jwt_secret_key

# Google Meet Developer Preview (Optional)
GOOGLE_MEET_CLIENT_ID=your_google_oauth_client_id
GOOGLE_MEET_CLIENT_SECRET=your_google_oauth_client_secret
```

### 3. Start Database & Backend

```bash
# Start PostgreSQL database via Docker
docker compose up -d

# Start backend server & Discord bot (TypeScript watch mode)
npm run dev
```

### 4. Start Web Dashboard

```bash
# In a separate terminal:
npm run dev:web
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Service Endpoints

| Service | Protocol | Endpoint | Description |
| :--- | :--- | :--- | :--- |
| **Web Dashboard** | HTTP | `http://localhost:5173` | Interactive Glassmorphic React UI |
| **REST API** | HTTP | `http://localhost:3000/api` | Core API & Device / Voice Management |
| **Health Check** | HTTP | `http://localhost:3000/api/health` | Server and database status check |
| **WebSocket Stream** | WS | `ws://localhost:3000/ws` | Authoritative real-time state synchronization |
| **Voice Command API** | HTTP | `http://localhost:3000/api/voice/command` | Voice transcript & command dispatch |
| **Google Meet API** | HTTP | `http://localhost:3000/api/meet/sessions` | Google Meet conference session manager |

---

## Google Meet Audio Routing Guide

Because the official Google Meet Media API reference client is receive-only, Gakki uses native OS virtual audio routing to send music and AI DJ commentary into meetings:

```text
┌──────────────────────────────────────────────────────────┐
│ Gakki Desktop Application                                │
│   Playback Target: "virtual"                             │
│                │                                         │
│                ▼                                         │
│   Virtual Audio Output (VB-Audio Cable / BlackHole)      │
└────────────────┬─────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────┐
│ Google Meet Client (Browser or Desktop App)              │
│   Settings → Audio → Microphone:                         │
│   Select "CABLE Output (VB-Audio Virtual Cable)"         │
│                │                                         │
│                ▼                                         │
│   All conference participants hear Gakki in stereo       │
└──────────────────────────────────────────────────────────┘
```

---

## Verification & Automated Test Suites

Run the automated test suites to verify functionality:

```bash
# Run full workspace typecheck
npm run typecheck

# Run Phase 13 Voice Commands & Gemini Live verification suite (64 tests)
npm run test:phase13

# Run Phase 12 Desktop Audio Output verification suite (41 tests)
npm run test:phase12

# Run full production build
npm run build
```

---

## License

This project is licensed under the [MIT License](LICENSE).
