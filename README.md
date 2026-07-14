# Emerald

Emerald Streaming is a Node.js/Express OBS recorder with the same browser UI and FFmpeg-backed recording workflow as the original app.

## Run Locally

```powershell
cd Emerald.Streaming
npm install
npm start
```

Open `http://127.0.0.1:5000`.

## OBS Setup

In OBS, set stream service to custom:

```text
Server: rtmp://127.0.0.1:1935/live
Stream Key: emerald
```

Then start streaming in OBS before clicking `Start OBS Preview + Recording` in Emerald.

From your other machine on the same network (10.0.0.x), open:

http://10.0.0.32:5173

Both Capture (live preview) and Playback (on-air HLS) pages will work there — same UI, same functionality.

What changed:

Frontend: Vite dev server now binds 0.0.0.0 instead of 127.0.0.1 (frontend/package.json).
Backend: now listens on 0.0.0.0:5000 instead of loopback-only (EMERALD_URLS in backend/.env).
Capture preview (WebRTC/WHEP): the browser negotiates this directly with MediaMTX using an absolute URL, so it needed the actual LAN IP — added MEDIAMTX_PUBLIC_HOST=10.0.0.32 to .env. Playback's HLS didn't need this (it's a relative path, works automatically once the backend is LAN-reachable).
Two things worth knowing:

That recording got interrupted by the backend restart, as expected — you approved it. Footage up to the stop point is intact; hit record again to continue.
MEDIAMTX_PUBLIC_HOST=10.0.0.32 is this machine's current IP — if it's on DHCP and ever changes, the Capture preview will break until .env is updated to match. If this machine has a static/reserved IP, no issue. You may also see a Windows Firewall prompt the first time a browser on another machine connects — allow it if so (I can't grant that myself, no admin rights in this shell).