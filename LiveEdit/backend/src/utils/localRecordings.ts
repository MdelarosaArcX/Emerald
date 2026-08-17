import fs from 'node:fs';

// Local filesystem path to the Emerald backend's own Recordings folder — only meaningful when
// Emerald and LiveEdit run on the same machine (see deploymentTopology.ts), letting recorded
// video be served straight off disk instead of fetched over HTTP from the Emerald backend. Shared
// by app.ts (registers the static route) and recordingCaptureSync.service.ts (decides whether to
// hand the frontend a local URL or the Emerald backend's HTTP one).
export const LOCAL_RECORDINGS_PATH = process.env.EMERALD_RECORDINGS_PATH || null;
export const LOCAL_RECORDINGS_AVAILABLE = Boolean(LOCAL_RECORDINGS_PATH && fs.existsSync(LOCAL_RECORDINGS_PATH));

// Emerald's Exports folder (clip exports joined from the Media Browser). Same local-disk
// shortcut as LOCAL_RECORDINGS_PATH above and same fallback: unset, or pointing somewhere that
// doesn't exist, means those files are fetched over HTTP like any other source.
export const LOCAL_EXPORTS_PATH = process.env.EMERALD_EXPORTS_PATH || null;
export const LOCAL_EXPORTS_AVAILABLE = Boolean(LOCAL_EXPORTS_PATH && fs.existsSync(LOCAL_EXPORTS_PATH));
