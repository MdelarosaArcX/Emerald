# Build the Installer — Step by Step

The short, practical walkthrough. For the reasoning, every parameter, the release checklist and the
full failure-mode table, see [BUILDING.md](BUILDING.md).

---

## 0. Prerequisites

| Tool | Version | Install |
| --- | --- | --- |
| .NET SDK | 8.0 | `winget install Microsoft.DotNet.SDK.8` |
| Node.js | 20 or newer | `winget install OpenJS.NodeJS.LTS` |
| Inno Setup | 6 | `winget install JRSoftware.InnoSetup` |
| FFmpeg | any Windows build | Unpack to `C:\ffmpeg` |

Roughly 8 GB of free disk, and internet access the first time (NuGet, npm, the WebView2
bootstrapper).

**The layout matters.** Two of the four packaged components live *outside* the Emerald repository
and are expected as siblings of it:

```text
I:\EmeraldDeltacast\
├── Emerald\                   <- the repository; run the build from here
├── DeltacastCaptureService\   <- required
└── MediaMtx\                  <- required
```

Elsewhere? Pass `-CaptureServicePath` and `-MediaMtxPath`. The build checks both before compiling
anything and stops in seconds with a message naming whichever is missing.

## 1. Close anything holding the ports

The verification step below refuses to run if the suite is already going, and the launcher is
single-instance. Quit it from its **tray icon** — closing the window only hides it — and stop any
`npm run dev` servers.

## 2. Build

```powershell
cd I:\EmeraldDeltacast\Emerald

powershell -ExecutionPolicy Bypass -File Installer\build\build-installer.ps1 -Version 1.2.1
```

Bump `-Version` on every build: it names the output file, fills the Add/Remove Programs entry, and
Windows compares it when upgrading.

Expect **10–20 minutes** from cold, most of it compressing a ~1.7 GB payload. Success ends with:

```text
Installer ready: I:\...\Installer\EmeraldDeltacastSuite-Setup-1.2.1.exe (468 MB)
```

Changing only the launcher, the config or the docs? Skip the slow stages — about 7 minutes:

```powershell
powershell -ExecutionPolicy Bypass -File Installer\build\build-installer.ps1 -Version 1.2.1 -SkipNpmInstall -SkipFrontendBuild
```

## 3. Verify

```powershell
powershell -ExecutionPolicy Bypass -File Installer\build\test-suite.ps1
```

Starts all five services from the built payload, exercises every port, API and proxy path, opens
both desktop windows and checks they render, then hard-kills the launcher to prove nothing is left
orphaned on the media ports.

Expect **76 passed, 0 failed**. It rewrites [TEST-REPORT.md](TEST-REPORT.md).

## 4. Collect the output

```text
Installer\EmeraldDeltacastSuite-Setup-<version>.exe
```

Around 468 MB. It is **gitignored** — a file that size is past GitHub's 100 MB hard limit, so
publish it as a release asset or to a file share rather than committing it.

---

## Faster loop while working on the launcher

Skip compression entirely and run the staged tree directly. It behaves exactly like an installed
copy, because everything resolves relative to the launcher's own folder:

```powershell
powershell -ExecutionPolicy Bypass -File Installer\build\build-installer.ps1 -StageOnly -SkipNpmInstall -SkipFrontendBuild
.\Installer\stage\Launcher\EmeraldLauncher.exe
```

## Building for a split deployment

If LiveEdit will run on a different machine from Emerald, those two addresses are compiled into the
LiveEdit bundle by Vite and are the one thing that **cannot** be changed after installation:

```powershell
.\Installer\build\build-installer.ps1 -Version 1.2.1 `
    -EmeraldApiBaseUrl     http://10.0.0.32:5000 `
    -EmeraldMonitorBaseUrl http://10.0.0.32:5173
```

---

## Known quirks on the current build machine

**Transient antivirus file locks.** Roughly one build in three fails with `PermissionDenied` /
`UnauthorizedAccess` on a file the build has just written, or ISCC exits 2 with no message at all.
**Re-run the identical command** — it has succeeded on retry every time. A Defender exclusion for
`I:\EmeraldDeltacast` removes the problem.

**A full system drive fails the build even when the repository's drive is empty.** npm and NuGet
cache under `%LOCALAPPDATA%`, and MSBuild and Inno Setup use `%TEMP%` — all on `C:`. The symptoms
are `npm error code ENOSPC` and NuGet `not enough space on the disk`. To get one build through:

```powershell
$env:TEMP = "I:\EmeraldDeltacast\.buildtemp"; $env:TMP = $env:TEMP
$env:npm_config_cache = "I:\EmeraldDeltacast\.buildtemp\npm-cache"
New-Item -ItemType Directory -Force -Path $env:TEMP, $env:npm_config_cache | Out-Null
```

That redirected cache starts empty, so that build re-downloads every npm package. It is a way round
a full disk, not a fix for one.
