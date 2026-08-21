# Suite Architecture

How the installed product is put together, and why it is put together that way. If you are only
trying to use the thing, [GETTING-STARTED.md](GETTING-STARTED.md) is the document you want.

## The shape of it

```
   ┌─────────────────────────────┐        ┌─────────────────────────────┐
   │  Emerald Capture (window)   │        │     LiveEdit (window)       │
   │  EmeraldLauncher --app      │        │  EmeraldLauncher --app      │
   │  emerald  →  WebView2       │        │  liveedit →  WebView2       │
   └──────────────┬──────────────┘        └──────────────┬──────────────┘
                  │ http://127.0.0.1:5173               │ http://127.0.0.1:5174
                  ▼                                      ▼
                        ┌──────────────────────────────────────┐
                        │      EmeraldLauncher.exe (tray)      │
                        │  starts, health-checks, supervises,  │
                        │  logs and stops everything below     │
                        └──────────────────────────────────────┘
                                          │  spawns (all inside one Windows job object)
        ┌─────────────────┬───────────────┼─────────────────┬──────────────────┐
        ▼                 ▼               ▼                 ▼                  ▼
┌───────────────┐ ┌──────────────┐ ┌─────────────┐ ┌────────────────┐ ┌────────────────┐
│  Deltacast    │ │   Emerald    │ │  Emerald    │ │   LiveEdit     │ │   LiveEdit     │
│  Capture Svc  │ │   Backend    │ │  Frontend   │ │   Backend      │ │   Frontend     │
│  :5055        │ │   :5000      │ │  :5173      │ │   :4123        │ │   :5174        │
│  .NET 8       │ │   Node       │ │  static+    │ │   Node         │ │  static+       │
│               │ │              │ │  proxy      │ │                │ │  proxy         │
└───────┬───────┘ └──────┬───────┘ └──────┬──────┘ └───────┬────────┘ └───────┬────────┘
        │                │                │                │                  │
        │  HTTP control  │                │  /api,/hls,    │                  │ /api,
        └───────────────▶│                └───────────────▶│◀─────────────────┘ /socket.io,
           (tx, capture, │   proxied to :5000              │   proxied to :4123  /proxies,
            edit-capture)│                                 │                     /renders
                         │  spawns                         │  spawns
                         ▼                                 ▼
                  ┌─────────────┐                    ┌──────────┐
                  │  MediaMTX   │                    │  FFmpeg  │
                  │ :8554 RTSP  │                    │ proxies, │
                  │ :8889 WHEP  │                    │ renders  │
                  └─────────────┘                    └──────────┘
                         ▲
                         │ SDI in/out
                  ┌──────┴──────┐
                  │  Deltacast  │
                  │  SDI board  │
                  └─────────────┘
```

## Ports

| Port | Bound by | Exposure |
| --- | --- | --- |
| 5055 | Deltacast Capture Service | Loopback only (hard-coded in the service) |
| 5000 | Emerald Backend | `0.0.0.0`, firewall closed by default |
| 5173 | Emerald Frontend | `0.0.0.0`, optional firewall rule |
| 4123 | LiveEdit Backend | `0.0.0.0`, firewall closed by default |
| 5174 | LiveEdit Frontend | `0.0.0.0`, optional firewall rule |
| 8554 | MediaMTX RTSP | Started by the Emerald backend |
| 8889 | MediaMTX WHEP (WebRTC) | Optional firewall rule |
| 1935 | RTMP ingest (OBS) | Started by the Emerald backend on demand |

## Installed layout

```
C:\Program Files\Emerald Deltacast Suite\
├── Launcher\                     EmeraldLauncher.exe + private .NET 8 runtime,
│                                 plus emerald.ico / emerald-capture.ico / liveedit.ico
├── redist\                       WebView2 bootstrapper, used only if the runtime is absent
├── DeltacastCaptureService\      self-contained .NET 8 service + appsettings.json
├── Emerald\
│   ├── backend\                  server.js, services\, db\, wwwroot\, node_modules\
│   └── frontend\                 built Vue bundle (index.html + assets\)
├── LiveEdit\
│   ├── backend\                  dist\, node_modules\
│   └── frontend\                 built Vue bundle
├── Node\node.exe                 the Node runtime both backends run on
├── ffmpeg\bin\                   ffmpeg.exe, ffprobe.exe and their DLLs
├── MediaMtx\                     mediamtx.exe + mediamtx.yml
├── runtime\static-server.js      the frontend static+proxy host
├── config\launcher.config.json   the service map (yours; survives upgrades)
├── docs\                         this documentation
└── build-info.json               version, build date, baked-in LiveEdit addresses
```

Runtime data is kept entirely separate, under `C:\ProgramData\EmeraldDeltacastSuite`. Nothing is
written back into Program Files, which is what lets the suite run as a standard user. The two
application windows additionally keep a WebView2 profile and their remembered window geometry per
user, under `%LOCALAPPDATA%\EmeraldDeltacastSuite\WebView2\<app id>` — separate profiles so the two
windows never contend for one profile lock.

## Design decisions

### Why bundle Node, .NET and FFmpeg

The target is a broadcast workstation that must keep working after somebody else updates it. Every
prerequisite is a way for that to fail: a Node major-version bump breaks `better-sqlite3`'s native
binding, a shared `C:\ffmpeg` gets replaced with a build missing an encoder, an ASP.NET runtime is
removed by a cleanup. Carrying private copies costs about a gigabyte of disk and removes the entire
category. The bundled `node.exe` is also the exact version `better-sqlite3` was compiled against
during the build, so its native module ABI always matches.

The one thing that cannot be bundled is Deltacast's VideoMaster driver — it ships with the board and
is licensed to its owner.

### Why the UIs are desktop windows rather than browser tabs

Emerald and LiveEdit are Vue applications, but an operator running a broadcast should not be
looking at them through an address bar, a tab strip and somebody's bookmarks — or hunting for the
right tab among fifteen, or losing the UI because a browser update restarted itself. Each UI is
hosted in a WinForms window by the Edge WebView2 runtime: same page, same locally served bundle,
but with its own taskbar entry, its own icon, remembered window geometry, and no browser chrome.
Default context menus and browser accelerator keys are switched off; `F5`, `F11`, `F12` and zoom
are wired up explicitly because there is no browser menu to fall back on.

Both windows and the control panel are **the same executable**. `EmeraldLauncher.exe --app emerald`
and `--app liveedit` open windows; with no arguments it is the supervisor. Shipping a separate app
shell would have meant a second copy of the self-contained .NET runtime — around 140 MB — for a few
hundred lines of window code.

WebView2 is the one runtime not bundled. It is a Windows component present on any current
Windows 10/11 machine, and the fixed-version alternative would add roughly 180 MB to the package to
guard against a case that barely occurs; setup detects it and runs the 2 MB evergreen bootstrapper
only when it is genuinely absent. If it is missing at runtime the window says exactly that and
points at the URL, rather than failing with a COM error.

Opening an application also starts the suite if it is not already up, so a shortcut on the desktop
is a complete entry point — the operator never has to know the control panel exists. Autoplay is
enabled for the embedded pages (`--autoplay-policy=no-user-gesture-required`) because both UIs put
a live video monitor on screen the moment they load, and WebView2 would otherwise block it until
someone clicked the page.

### Why the frontends are not served by their own backends

In development each frontend runs under Vite, which serves the app *and* proxies `/api`, `/hls`,
`/socket.io` and the media paths to that frontend's backend, so the browser talks to a single
origin. `vite build` only produces the first half. Rather than add static-file and proxy routes to
the two backends — new production-only code paths in the most safety-critical part of the system —
`runtime\static-server.js` reproduces exactly what Vite was doing. Same ports, same proxy prefixes,
same single-origin behaviour, so the installed product routes requests identically to the
development setup that was tested.

### Why a supervisor rather than five Windows services

Windows services run in session 0 and cannot show a UI, which is wrong for a product an operator
sits in front of and drives from a browser. The suite also has a real startup *order* — the
frontends proxy to backends, the Emerald backend brings up MediaMTX — and service dependencies
express "started" (the process exists), not "ready to answer HTTP". The launcher waits on an actual
health endpoint before moving to the next service. It also gives the operator one place to see
status, restart one component, and read logs.

### Why every child is in a job object

`node server.js` spawns FFmpeg and MediaMTX; the capture service spawns FFmpeg too. Killing only the
parent leaves those grandchildren alive, still holding ports 5000, 8554 and 8889 and still holding
SDI channels open — and the next start then fails with a port-in-use error that looks nothing like
its actual cause. Every process is added to a Windows job object created with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the whole tree dies together even if the launcher itself is
killed from Task Manager. Normal shutdown additionally uses `Process.Kill(entireProcessTree: true)`.

### Why the capture service is optional

`required: false` on the Deltacast service means a machine with no SDI board still gets a fully
working Emerald and LiveEdit: the row goes red, a balloon tip explains it, and startup continues.
Editing, playback, exports and the media browser do not involve the board at all. On a machine that
does have one, the same failure is still visible and still logged.

### Why uninstall keeps your data

Recordings and exports are the operator's work product and can run to hundreds of gigabytes.
Removing an application is not consent to delete them, so the uninstaller leaves
`C:\ProgramData\EmeraldDeltacastSuite` alone and tells you where it is. A reinstall picks the same
data back up.

## Startup sequence

1. **Launcher starts.** Takes a global mutex (a second copy refuses to run and points at the tray
   icon), reads `config\launcher.config.json`, and creates the data folders.
2. **Deltacast Capture Service** (order 10) — opens SDI channels, waits for
   `GET :5055/capture/status`. Optional; a failure here does not stop the rest.
3. **Emerald Backend** (order 20) — opens the database, starts MediaMTX, waits for
   `GET :5000/api/system/status`.
4. **Emerald Frontend** (order 30) — static host on 5173, waits for `GET :5173/`.
5. **LiveEdit Backend** (order 40) — waits for `GET :4123/api/status`.
6. **LiveEdit Frontend** (order 50) — static host on 5174, waits for `GET :5174/`.

Each step polls its health URL once a second until it answers or the timeout expires. Anything
below HTTP 500 counts as alive. Shutdown runs the same list in reverse, so a frontend never
outlives the backend it proxies to.
