import fs from 'node:fs';

// Local filesystem path to the Emerald backend's own Recordings folder — only meaningful when
// Emerald and LiveEdit run on the same machine (see deploymentTopology.ts), letting recorded
// video be served straight off disk instead of fetched over HTTP from the Emerald backend. Shared
// by app.ts (registers the static route) and recordingCaptureSync.service.ts (decides whether to
// hand the frontend a local URL or the Emerald backend's HTTP one).
export const LOCAL_RECORDINGS_PATH = process.env.EMERALD_RECORDINGS_PATH || null;
export const LOCAL_RECORDINGS_AVAILABLE = Boolean(LOCAL_RECORDINGS_PATH && fs.existsSync(LOCAL_RECORDINGS_PATH));
