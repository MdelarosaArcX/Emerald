# Emerald

Emerald Streaming is a Node.js/Express OBS recorder with the same browser UI and FFmpeg-backed recording workflow as the original app.

## Desktop Installer

Emerald and LiveEdit also ship as two Windows desktop applications with a single installer that
carries every runtime they need (Node, .NET, FFmpeg, MediaMTX) and supervises all five services.

Everything for it lives in [`Installer/`](Installer/):

```powershell
# build          -> Installer\EmeraldDeltacastSuite-Setup-<version>.exe
powershell -ExecutionPolicy Bypass -File Installer\build\build-installer.ps1 -Version 1.1.0

# verify the built payload end to end
powershell -ExecutionPolicy Bypass -File Installer\build\test-suite.ps1
```

| Document | For |
| --- | --- |
| [Installer/docs/BUILD-STEPS.md](Installer/docs/BUILD-STEPS.md) | **Building the installer, step by step** |
| [Installer/docs/BUILDING.md](Installer/docs/BUILDING.md) | Build reference — prerequisites, every option, release checklist, failure modes |
| [Installer/docs/GETTING-STARTED.md](Installer/docs/GETTING-STARTED.md) | Operators — install, run, where files live |
| [Installer/docs/CONFIGURATION.md](Installer/docs/CONFIGURATION.md) | Every setting in `launcher.config.json` |
| [Installer/docs/ARCHITECTURE.md](Installer/docs/ARCHITECTURE.md) | How the packaged suite fits together and why |
| [Installer/docs/TROUBLESHOOTING.md](Installer/docs/TROUBLESHOOTING.md) | When a service or a window will not start |
| [Installer/docs/TEST-REPORT.md](Installer/docs/TEST-REPORT.md) | Results of the last verification run |

Note that the installer packages two components from **outside this repository** —
`../DeltacastCaptureService` and `../MediaMtx` — so a checkout of Emerald on its own is not enough
to build it.

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