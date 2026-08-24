# Troubleshooting

Start in the same place every time: open the control panel, click the red row, and read the log
pane at the bottom. The full logs are in `C:\ProgramData\EmeraldDeltacastSuite\logs` — one file per
service, plus the previous run kept as `.log.1`, which is usually the one you want after a crash.

## A service will not start

### "Deltacast Capture Service" is red

Almost always expected, and almost always one of three things.

**No board or no driver.** The service needs Deltacast's VideoMaster runtime, which ships with the
SDI board's driver package and is not bundled. The log shows a `DllNotFoundException` or a failure
opening `VideoMasterHD`. Install the board driver from Deltacast. On a machine that will never have
a board, leave the row red — the service is marked optional and everything else works — or remove
its entry from `config\launcher.config.json`.

**Board present, channel busy.** `Channel already in use` or a failure opening RX3/TX2 means
another process still holds it. Usually a previous run that was killed instead of quit. Quit the
suite from the tray, check Task Manager for stray `DeltacastCaptureService.exe` or `ffmpeg.exe`
processes, end them, and start again.

**`RX3 is not an SDI channel. Channel type is 0.`** The board was found and opened, but the channel
the service was told to use is not configured as an SDI input. Either the board's firmware profile
does not expose that channel as SDI, or `Capture:ChannelIndex` / `Transmit:ChannelIndex` in
`DeltacastCaptureService\appsettings.json` names the wrong one. Check the channel layout in
Deltacast's own board utility and set the indexes to match. Everything else in the suite keeps
running while this is unresolved.

If the log shows a *different* channel number or frame rate from the one in `appsettings.json`, the
service is not reading that file at all — check that the `deltacast-capture` entry in
`config\launcher.config.json` still passes `--contentRoot "{APP}\DeltacastCaptureService"`. A .NET
host reads `appsettings.json` from its content root, which otherwise defaults to the (deliberately
different) working directory, and it falls back to built-in defaults silently.

**No SDI signal.** The service starts but reports no signal lock. Check the cable and that the
source matches the configured format (1920×1080, 25 fps, UYVY by default — see
`DeltacastCaptureService\appsettings.json`).

To prove the rest of the pipeline without hardware, add `"Capture__Simulate": "true"` to that
service's `environment` block and restart. It feeds synthetic test-pattern frames through the same
queue and edit-capture path.

### "Emerald Backend" is red

**Port 5000 already in use.** The log ends with `EADDRINUSE`. Find the holder:

```powershell
Get-NetTCPConnection -LocalPort 5000 -State Listen | ForEach-Object { Get-Process -Id $_.OwningProcess }
```

A leftover `node.exe` from a previous run is the usual answer. Note that another copy of the suite
running from a *development* checkout will collide with the installed one on every port.

**Database cannot be opened.** `SQLITE_CANTOPEN` means `{DATA}\db` is missing or not writable.
Confirm `C:\ProgramData\EmeraldDeltacastSuite\db` exists and that your account can write to it; the
installer creates it with modify rights for Users.

**`EPERM: operation not permitted, mkdir '...\Emerald\backend\logs'`.** The backend is trying to
write its logs beside its own code, inside Program Files, which is read-only for a standard user.
`EMERALD_LOG_PATH` is missing from the `emerald-backend` service's `environment` block in
`config\launcher.config.json` — it should be `{DATA}\logs`. Compare your config against
`launcher.config.default.json`; an upgrade never overwrites your copy, so a config edited before
this setting existed will not have it.

**MediaMTX not found.** The message names the path it tried. Check `MEDIAMTX_PATH` in
`config\launcher.config.json` points at `{APP}\MediaMtx\mediamtx.exe` and that the file is there.

### "LiveEdit Backend" is red

**Port 4123 in use** — same diagnosis as above with a different port.

**Cannot write `.media-cache`.** LiveEdit creates its proxy and render cache relative to its working
directory, which is `{DATA}\LiveEdit`. If that path was edited to somewhere read-only, the process
exits during module load, before it logs anything useful.

### A frontend is red

`SERVE_ROOT ... does not contain an index.html` means the built bundle is missing — the install is
incomplete, so reinstall. `listen failed on 0.0.0.0:5173` means something else holds the port; a
Vite dev server from a development checkout is the usual culprit.

## An application window will not open

**"The Microsoft Edge WebView2 runtime is not installed on this machine."** The windows are drawn by
WebView2, which is a Windows component the installer does not bundle. Install it from
<https://developer.microsoft.com/microsoft-edge/webview2/> (the Evergreen Standalone Installer), or
re-run setup on a machine with internet access — it installs the runtime automatically when it is
missing. In the meantime the same UI is reachable in a browser at the URL the window names.

**The window opens but sits on "Waiting for the suite to finish starting".** The window is waiting
for its service, so this is a service problem, not a window problem — open the control panel and
look for the red row. If the wait runs out you get a **Retry** button; nothing is lost by pressing
it once the service is green.

**"Lost the connection to http://127.0.0.1:5173".** The frontend service stopped or restarted under
the window. Press **Retry**. If it keeps happening, that service's log will say why.

**Double-clicking the shortcut does nothing.** The application is already running — a second launch
raises the existing window rather than opening a duplicate. Check the taskbar and Alt-Tab. The two
applications have deliberately different icons: teal with a record dot for Emerald Capture, violet
for LiveEdit.

**The window is off-screen after a monitor change.** Position is remembered per user, but only
restored when it still lands on a connected screen. If it ever does get stranded, delete
`%LOCALAPPDATA%\EmeraldDeltacastSuite\WebView2\<app id>\window.json` and reopen.

## The UI loads but nothing works

### API calls return HTML instead of JSON

The browser is getting `index.html` for an `/api` request, which means that prefix is not being
proxied. Check `PROXY_PREFIXES` for that frontend in `config\launcher.config.json` — a path missing
from the list falls through to the single-page-app fallback rather than 404ing, so the symptom
looks like corrupt data rather than a routing mistake. The shipped values are:

- Emerald frontend: `/api,/hls,/recordings,/exports,/edit-captures`
- LiveEdit frontend: `/api,/socket.io,/proxies,/renders,/local-recordings,/local-exports`

### "Backend unavailable" in the UI

The static host answered but could not reach its backend. That row is amber or red in the control
panel — fix the backend and the frontend recovers on its own, no restart needed.

### The WebRTC preview is black from another machine

`MEDIAMTX_PUBLIC_HOST` is still `127.0.0.1`. That value is baked into an absolute URL the remote
browser dials directly, so it must be this machine's LAN IP. Set it, restart the Emerald backend
row, and confirm TCP 8889 is allowed through the firewall.

### The preview is black on this machine too

Check the Deltacast row first — no capture means no preview. If capture is running, the Emerald
backend log will show the FFmpeg command it launched and FFmpeg's own error.

### LiveEdit shows no media

LiveEdit reads recordings from the Emerald backend. Check `EMERALD_BACKEND_URL` and that the Emerald
row is green. If `EMERALD_RECORDINGS_PATH` points somewhere that does not exist, LiveEdit logs a
warning and falls back to fetching over HTTP — slower, but it still works.

## Installation problems

**"Setup cannot continue — the application is running."** Quit the suite from its tray icon (not
just the window's X, which only hides it) and retry.

**Antivirus flags the installer.** The package is unsigned and contains FFmpeg, MediaMTX and a
private Node runtime, which some heuristics dislike. Sign the installer for production deployment,
or add an exclusion for the install folder.

**Upgrade did not pick up new settings.** Deliberate: your `config\launcher.config.json` is never
overwritten. Compare it against `config\launcher.config.default.json`, which is refreshed on every
upgrade, and merge what you want.

## Getting a clean slate

```powershell
# 1. Quit from the tray icon, then confirm nothing survived
Get-Process node, ffmpeg, mediamtx, DeltacastCaptureService, EmeraldLauncher -ErrorAction SilentlyContinue

# 2. Confirm the ports are free
Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 5000,5055,5173,5174,4123,8554,8889

# 3. Reset configuration to the shipped defaults
Copy-Item "C:\Program Files\Emerald Deltacast Suite\config\launcher.config.default.json" `
          "C:\Program Files\Emerald Deltacast Suite\config\launcher.config.json" -Force
```

Step 1 returning processes after a proper quit is worth reporting — the job object should have taken
the whole tree down with it.

## What to include in a bug report

- `build-info.json` from the install folder (version and build date)
- The failing service's `.log` **and** `.log.1` from the logs folder
- The output of the three commands above
- Whether a Deltacast board is fitted, and its driver version
