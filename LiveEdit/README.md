# Emerald Live Edit

A professional broadcast editing suite UI, built as a dark, teal/emerald-accented
control room interface inspired by EDIUS, Premiere, Resolve, OBS, and vMix.

## Structure

```
emerald-live-edit/
├── backend/    Express + Socket.IO REST/WebSocket API (mock data, FFmpeg-ready)
└── frontend/   Vue 3 + TypeScript + Vite editing UI
```

## Getting Started

### Backend

```
cd backend
npm install
cp .env.example .env
npm run dev
```

Runs on `http://localhost:4000`. Exposes REST endpoints under `/api` and a
Socket.IO server for realtime timeline/playback/capture events.

### Frontend

```
cd frontend
npm install
npm run dev
```

Runs on `http://localhost:5173` with `/api` and `/socket.io` proxied to the
backend (see `vite.config.ts`).

## Notes

- FFmpeg capture/render/transcoding is intentionally **not implemented** —
  the backend exposes stable API contracts (`/api/capture`, `/api/render`)
  ready for a future ingest/render pipeline.
- Timeline, playback, capture, project, and settings state live in dedicated
  Pinia stores (`frontend/src/stores`).
- Socket.IO event names are kept in sync between
  `backend/src/sockets/index.ts` and `frontend/src/services/socket.ts`.
