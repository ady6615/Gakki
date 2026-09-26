# Gakki — Architecture Document

> **Version:** 0.1.0 (Phase 1)
> **Last Updated:** 2026-09-26

---

## 1. Overview

Gakki is a **modular music and voice platform** designed for cross-platform audio playback, starting with Discord. The core architectural principle is **platform independence**: the music engine contains all business logic and has zero coupling to Discord, Express, or any specific platform.

---

## 2. System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Clients                                     │
│                                                                      │
│   React Web UI (Vite)  ◄──── HTTP/WS ────►  Express API Server      │
│   Port 5173 (dev)                            Port 3000               │
└───────────────────────────────────┬──────────────────────────────────┘
                                    │
                     ┌──────────────▼──────────────┐
                     │     @gakki/core              │
                     │  Platform-Agnostic Engine    │
                     │                              │
                     │  ┌────────────────────────┐  │
                     │  │  Queue Manager         │  │
                     │  │  Track Manager         │  │
                     │  │  Playlist Manager      │  │
                     │  │  Playback Manager      │  │
                     │  │  Audio Source Manager   │  │
                     │  │  Analytics Manager     │  │
                     │  │  AI Recommendation Mgr │  │  ← future
                     │  │  Lyrics Manager        │  │  ← future
                     │  │  Recording Manager     │  │  ← future
                     │  └────────────────────────┘  │
                     │                              │
                     │  Types · Database · Logger   │
                     └──────────────┬───────────────┘
                                    │
                     ┌──────────────▼───────────────┐
                     │   Platform Adapter Layer      │
                     │                               │
                     │  ┌─────────────────────────┐  │
                     │  │  Discord Adapter         │  │  ← active
                     │  │  (discord.js)            │  │
                     │  └─────────────────────────┘  │
                     │  ┌─────────────────────────┐  │
                     │  │  Desktop Adapter         │  │  ← planned
                     │  │  Google Meet Adapter     │  │  ← planned
                     │  └─────────────────────────┘  │
                     └──────────────┬───────────────┘
                                    │
                     ┌──────────────▼───────────────┐
                     │       Infrastructure          │
                     │                               │
                     │  PostgreSQL + pgvector         │
                     │  Docker (dev environment)      │
                     │  FFmpeg (future: transcoding)  │
                     └───────────────────────────────┘
```

---

## 3. Package Structure

The project is a **monorepo** using npm workspaces with three packages:

### `@gakki/core` — The Engine

**Purpose:** Platform-agnostic business logic. Contains ALL domain types, database schema, and manager classes.

**Key constraint:** This package MUST NOT import `discord.js`, `express`, or any platform-specific library. It defines the `PlatformAdapter` interface that platforms implement.

| Module | Role | Phase 1 Status |
|--------|------|----------------|
| Types | Shared type definitions (Track, Queue, Playlist, etc.) | ✅ Implemented |
| Database | Drizzle ORM schema + PostgreSQL connection pool | ✅ Implemented |
| Logger | Structured logging via pino | ✅ Implemented |
| Config | Environment validation via zod | ✅ Implemented |
| QueueManager | Per-guild playback queue operations | 🏗 Skeleton |
| TrackManager | Track CRUD and resolution | 🏗 Skeleton |
| PlaylistManager | Playlist CRUD | 🏗 Skeleton |
| PlaybackManager | Audio pipeline coordination | 🏗 Skeleton |
| AudioSourceManager | External source adapters | 🏗 Skeleton |
| AnalyticsManager | Playback event recording | 🏗 Skeleton |
| AiRecommendationManager | ML-based recommendations | ⏳ Stub |
| LyricsManager | Lyrics fetching | ⏳ Stub |
| RecordingManager | Voice recording | ⏳ Stub |

### `@gakki/server` — The Runtime

**Purpose:** Hosts the Express API, Discord bot, and WebSocket server. Imports `@gakki/core` and wires everything together.

| Module | Role | Phase 1 Status |
|--------|------|----------------|
| API Server | Express HTTP server with health endpoint | ✅ Implemented |
| Discord Bot | discord.js client connection | ✅ Implemented |
| Discord Adapter | Implements `PlatformAdapter` for Discord | ✅ Implemented |
| WebSocket | Real-time communication server | ✅ Shell |
| Error Handler | Global Express error middleware | ✅ Implemented |

### `@gakki/web` — The Frontend

**Purpose:** React + Vite dashboard for the web UI.

| Feature | Phase 1 Status |
|---------|----------------|
| Health check dashboard | ✅ Implemented |
| Queue management (drag-and-drop) | ⏳ Planned |
| Playlist browser | ⏳ Planned |
| Playback controls | ⏳ Planned |

---

## 4. Key Design Decisions

### 4.1 Platform Adapter Pattern

The `PlatformAdapter` interface in `@gakki/core` defines the contract that any platform must implement:

```typescript
interface PlatformAdapter {
  readonly platform: string;
  readonly state: PlatformConnectionState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}
```

Discord is the first implementation. Future platforms (Desktop audio, Google Meet) will implement the same interface, allowing the core engine to work identically across all of them.

### 4.2 Graceful Degradation

The server starts even if individual services are unavailable:
- **No database?** API starts, health check reports "disconnected"
- **No Discord token?** API starts, Discord bot is skipped
- This enables frontend development without requiring all infrastructure

### 4.3 Monorepo with npm Workspaces

Using npm workspaces (no Turborepo/Lerna) for simplicity:
- `@gakki/core` is imported by `@gakki/server` via workspace resolution
- `@gakki/web` is independent (communicates via HTTP/WS)
- Shared TypeScript base config reduces duplication

### 4.4 Database: Drizzle ORM

Drizzle was chosen over Prisma/TypeORM for:
- Zero runtime overhead (SQL is generated at build time)
- Schema-as-code (TypeScript files, not a DSL)
- First-class PostgreSQL support including pgvector for future AI features

---

## 5. Data Model

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────┐
│   tracks     │◄────│ playlist_tracks   │────►│  playlists    │
│              │     │                  │     │               │
│ id           │     │ id               │     │ id            │
│ title        │     │ playlist_id (FK) │     │ name          │
│ artist       │     │ track_id (FK)    │     │ description   │
│ album        │     │ position         │     │ created_at    │
│ duration_sec │     │ added_at         │     │ updated_at    │
│ file_path    │     └──────────────────┘     └───────────────┘
│ source_type  │
│ source_id    │     ┌──────────────────┐
│ created_at   │◄────│ playback_events  │
└─────────────┘     │                  │
                     │ id               │
                     │ track_id (FK)    │
                     │ guild_id         │
                     │ platform         │
                     │ played_at        │
                     │ duration_played  │
                     └──────────────────┘
```

---

## 6. Technology Stack

| Technology | Purpose | Why This Choice |
|------------|---------|-----------------|
| TypeScript | All application code | Type safety across the entire codebase |
| Node.js ≥ 20 | Runtime | LTS, native ES modules, stable |
| discord.js | Discord API | Official library, well-maintained |
| Express | HTTP API server | Minimal, battle-tested, huge ecosystem |
| ws | WebSocket server | Lightweight, no framework overhead |
| React | Frontend UI | Component model, large ecosystem |
| Vite | Frontend build/dev | Fast HMR, simple config |
| PostgreSQL | Persistent storage | ACID, JSON support, pgvector extension |
| pgvector | Audio embeddings | Vector similarity search for AI features |
| Drizzle ORM | Database access | Type-safe SQL, zero runtime overhead |
| pino | Logging | Fastest Node.js logger, structured JSON |
| zod | Config/input validation | Runtime type checking, great TS inference |
| Docker | Dev database | Reproducible PostgreSQL setup |

### Planned Future Additions

| Technology | Purpose | When |
|------------|---------|------|
| @discordjs/voice | Voice connections | Phase 2 (playback) |
| FFmpeg | Audio transcoding | Phase 2 (playback) |
| Python + librosa/Essentia | Audio analysis | Phase 3 (AI features) |

---

## 7. API Endpoints

### Phase 1

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | System health check |

### Planned

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/queue/:guildId` | Get queue state |
| POST | `/api/queue/:guildId/tracks` | Add track to queue |
| DELETE | `/api/queue/:guildId/tracks/:id` | Remove from queue |
| PATCH | `/api/queue/:guildId/reorder` | Reorder queue |
| GET | `/api/playlists` | List playlists |
| POST | `/api/playlists` | Create playlist |
| POST | `/api/tracks/upload` | Upload local file |
| GET | `/api/stats` | Playback statistics |

---

## 8. Running the Project

```bash
# Start database
docker compose up -d

# Configure environment
cp .env.example .env
# Add DISCORD_TOKEN and DISCORD_CLIENT_ID to .env

# Install dependencies
npm install

# Start backend (API + Discord bot)
npm run dev

# Start frontend (separate terminal)
npm run dev:web
```

---

## 9. Phase Roadmap

| Phase | Focus | Status |
|-------|-------|--------|
| 1 | Architecture, types, connections, health checks | ✅ Current |
| 2 | Audio playback pipeline, basic queue, local file upload | ⏳ Next |
| 3 | Web UI queue management, playlists, playback controls | ⏳ Planned |
| 4 | Internet source adapters (YouTube, etc.) | ⏳ Planned |
| 5 | Playback statistics, lyrics | ⏳ Planned |
| 6 | AI features (smart shuffle, vibe playlists, embeddings) | ⏳ Planned |
| 7 | Voice recording | ⏳ Planned |
| 8 | Desktop audio adapter, Google Meet adapter | ⏳ Planned |
