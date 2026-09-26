# Gakki

A modular music and voice platform powered by AI, with Discord and future cross-platform support.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [Docker](https://www.docker.com/) (for PostgreSQL)
- A [Discord bot token](https://discord.com/developers/applications)

### Setup

```bash
# 1. Clone and install
npm install

# 2. Start the database
docker compose up -d

# 3. Configure environment
cp .env.example .env
# Edit .env and add your DISCORD_TOKEN and DISCORD_CLIENT_ID

# 4. Start the backend (API + Discord bot)
npm run dev

# 5. Start the frontend (in another terminal)
npm run dev:web
```

### Endpoints

| Service   | URL                          |
|-----------|------------------------------|
| API       | http://localhost:3000         |
| Health    | http://localhost:3000/api/health |
| WebSocket | ws://localhost:3000/ws        |
| Frontend  | http://localhost:5173         |

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a detailed explanation of the system design.

## Project Structure

```
packages/
├── core/       # Platform-agnostic music engine (types, database, managers)
├── server/     # API server + Discord bot + WebSocket
└── web/        # React + Vite frontend
```

## License

MIT
