# Installer

Everything needed to turn this repository into two Windows desktop applications — **Emerald Capture**
and **LiveEdit** — that install, run and supervise the whole Emerald / Deltacast system: the
**Deltacast Capture Service**, **Emerald** (backend + frontend) and **LiveEdit** (backend +
frontend).

## Build it

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File Installer\build\build-installer.ps1 -Version 1.1.0
```

Produces `Installer\EmeraldDeltacastSuite-Setup-1.1.0.exe` — about 470 MB, 10–20 minutes from cold.

Needs the .NET 8 SDK, Node 20+, Inno Setup 6 and a Windows FFmpeg build — **and two components that
live outside this repository**: `DeltacastCaptureService` and `MediaMtx`, expected as siblings of the
repository folder or pointed at with `-CaptureServicePath` / `-MediaMtxPath`. The full build process,
every option, the release checklist and the known failure modes are in
[docs/BUILDING.md](docs/BUILDING.md).

Build output is deliberately **not** committed: `Installer\stage\` (~1.7 GB) and `Installer\*.exe`
(~470 MB) are in the repository's `.gitignore`, since a single file that size is past GitHub's hard
limit. Publish the installer as a release asset instead.

## Test it

```powershell
powershell -ExecutionPolicy Bypass -File Installer\build\test-suite.ps1
```

Starts the built payload, exercises every service, port, API and proxy path, then kills the
launcher to confirm nothing is left running. Writes [docs/TEST-REPORT.md](docs/TEST-REPORT.md).

## Documentation

| Document | For |
| --- | --- |
| [GETTING-STARTED.md](docs/GETTING-STARTED.md) | Operators — install, run, where files live |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | Every setting in `launcher.config.json` |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the suite fits together and why |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | When something is red |
| [BUILDING.md](docs/BUILDING.md) | Building, signing and shipping the installer |
| [TEST-REPORT.md](docs/TEST-REPORT.md) | Results of the last verification run |
| [LICENSE-NOTICES.txt](docs/LICENSE-NOTICES.txt) | Third-party licences (FFmpeg, Node, MediaMTX, .NET) |

## What is in here

```
Installer\
├── build\
│   ├── build-installer.ps1   compiles everything and runs Inno Setup
│   ├── setup.iss             the Inno Setup script
│   ├── make-icon.ps1         draws the three .ico files (no design tool needed)
│   └── test-suite.ps1        end-to-end verification
├── launcher\                 the .NET 8 WinForms app: control panel + the two app windows
│   ├── Program.cs            entry point, single-instance guard, data folders
│   ├── LauncherConfig.cs     reads config\launcher.config.json, expands {APP} / {DATA}
│   ├── ServiceSupervisor.cs  one per service: start, health-check, log, restart, stop
│   ├── ProcessJob.cs         job object so ffmpeg/mediamtx die with the launcher
│   ├── MainForm.cs           control panel, tray icon, log pane
│   └── AppWindow.cs          the WebView2 desktop window for Emerald Capture / LiveEdit
├── runtime\
│   ├── static-server.js      serves each built frontend and proxies its backend paths
│   └── launcher.config.json  the shipped service map
├── docs\                     the documentation above, packaged with the product
├── stage\                    build output: the install tree, verbatim (gitignored)
└── EmeraldDeltacastSuite-Setup-<version>.exe   (gitignored)
```

Two of the four packaged components live outside this repository — `..\DeltacastCaptureService` and
`..\MediaMtx` — so a checkout of Emerald alone is not enough to build the installer. See
[docs/BUILDING.md](docs/BUILDING.md#1-what-the-build-needs-to-see).

## The short version of the design

- **Two desktop apps, five services.** Emerald Capture and LiveEdit each open as a native WebView2
  window with its own icon and taskbar entry — no browser. Behind them, the control panel starts
  the services in dependency order, waits for each to answer a health endpoint before starting the
  next, tails their logs, restarts them if they crash, and stops them in reverse order.
- **One executable, three modes.** `EmeraldLauncher.exe` is the control panel; `--app emerald` and
  `--app liveedit` are the two application windows. Sharing a binary avoids shipping a second copy
  of the self-contained .NET runtime.
- **Nothing to install first.** Node, the .NET runtime, FFmpeg and MediaMTX are bundled. The
  external dependencies are Deltacast's board driver, which cannot be redistributed, and Microsoft's
  Edge WebView2 runtime, which is a Windows component setup installs if it is somehow absent.
- **Program Files stays read-only.** All runtime data lives in
  `C:\ProgramData\EmeraldDeltacastSuite`, so the suite runs as a standard user — and an uninstall
  leaves your recordings alone.
- **The frontends are served the way Vite served them.** `runtime\static-server.js` reproduces the
  dev server's static + proxy behaviour, so a packaged build routes requests identically to the
  development setup.
- **Everything the launcher runs is in one job object**, so a crash or a hard kill cannot leave
  orphaned FFmpeg processes squatting on the media ports.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the reasoning behind each of these.
