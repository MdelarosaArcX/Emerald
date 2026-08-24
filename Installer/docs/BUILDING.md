# Building the Installer

How to turn a checkout into `EmeraldDeltacastSuite-Setup-<version>.exe`, and why it works the way
it does.

**Just want the commands?** [BUILD-STEPS.md](BUILD-STEPS.md) is the step-by-step walkthrough. This
document is the reference behind it.

---

## 1. What the build needs to see

The installer packages four components, and **they do not all live in the Emerald repository**. The
capture service and MediaMTX are siblings of it:

```text
I:\EmeraldDeltacast\                  <- workspace root (not a repository itself)
├── Emerald\                          <- the Emerald repository
│   ├── backend\                        Emerald backend (Node)
│   ├── frontend\                       Emerald UI (Vue)
│   ├── LiveEdit\
│   │   ├── backend\                    LiveEdit backend (TypeScript)
│   │   └── frontend\                   LiveEdit UI (Vue)
│   └── Installer\                    <- everything in this folder
│       ├── build\                      the build scripts and Inno Setup script
│       ├── launcher\                   the desktop app (C#)
│       ├── runtime\                    static-server.js + launcher.config.json
│       └── docs\                       this documentation
├── DeltacastCaptureService\          <- separate repository
└── MediaMtx\                         <- mediamtx.exe + mediamtx.yml
```

The build derives all of this from its own location: `Installer\build\` → the Emerald repository is
two levels up, the workspace one further. If your layout differs, point it at the two outside
components explicitly:

```powershell
.\Installer\build\build-installer.ps1 `
    -CaptureServicePath D:\src\DeltacastCaptureService `
    -MediaMtxPath       D:\tools\mediamtx
```

Both are checked before anything is compiled, so a missing sibling fails in seconds with a message
saying which one and why — not three minutes in with a copy error.

## 2. Build machine prerequisites

| Tool | Version | Install |
| --- | --- | --- |
| .NET SDK | 8.0 | `winget install Microsoft.DotNet.SDK.8` |
| Node.js | 20 or newer | `winget install OpenJS.NodeJS.LTS` |
| Inno Setup | 6 | `winget install JRSoftware.InnoSetup` |
| FFmpeg | any Windows build | Unpack to `C:\ffmpeg` (or pass `-FfmpegBinDir`) |
| Internet access | once | NuGet packages, npm packages, the WebView2 bootstrapper |

Roughly 8 GB of free disk: about 1.7 GB of staged payload, the same again in npm and NuGet caches,
and the ~470 MB output.

Every one of these is verified before the build starts and fails fast with a message naming the
missing tool.

### The Node version is not incidental

The build copies **the build machine's own `node.exe`** into the package, and runs `npm install`
with that same npm to produce the shipped `node_modules`. `better-sqlite3` is a native module
compiled against a specific Node ABI, so shipping the runtime it was built against is what stops the
two drifting apart. Build with Node 20 and the package runs Node 20; build with 22 and it runs 22.

Do not hand-edit `node_modules` in the staging tree afterwards — rebuild instead.

## 3. The short version

From the Emerald repository root:

```powershell
powershell -ExecutionPolicy Bypass -File Installer\build\build-installer.ps1 -Version 1.1.0
```

Output: `Installer\EmeraldDeltacastSuite-Setup-1.1.0.exe`.

A cold build takes 10–20 minutes; most of that is LZMA2 compressing the payload. An incremental one
(`-SkipNpmInstall -SkipFrontendBuild`) is about 7, nearly all compression.

Then verify it:

```powershell
powershell -ExecutionPolicy Bypass -File Installer\build\test-suite.ps1
```

## 4. What the build does, step by step

| # | Step | Notes |
| --- | --- | --- |
| 1 | **Check tools and layout** | Node ≥ 20, npm, .NET SDK, Inno Setup, FFmpeg, and both outside components |
| 2 | **Draw the icons** (`make-icon.ps1`) | `emerald.ico`, `emerald-capture.ico`, `liveedit.ico` — generated in code, not committed as art |
| 3 | **Publish the launcher** | `win-x64`, self-contained, ~145 MB |
| 4 | **Publish the capture service** | `win-x64`, self-contained, ~98 MB |
| 5 | **Stage the Emerald backend** | `server.js`, `services\`, `db\`, `wwwroot\`, then `npm install --omit=dev` **in the staging folder** |
| 6 | **Build the Emerald frontend** | `vue-tsc --noEmit && vite build`; only `dist` is staged |
| 7 | **Build the LiveEdit backend** | `tsc`, then `npm install --omit=dev` in staging |
| 8 | **Build the LiveEdit frontend** | With the Emerald addresses compiled in (see below) |
| 9 | **Stage the runtimes** | `node.exe`, FFmpeg (minus `ffplay.exe`), MediaMTX, WebView2 bootstrapper |
| 10 | **Stage runtime + config + docs** | `static-server.js`, `launcher.config.json`, `docs\`, `build-info.json` |
| 11 | **Compile** | ISCC over `build\setup.iss` |

Two details in there matter more than the rest.

**Step 5 and 7 install dependencies into the staging tree, not the source tree.** The development
checkout hoists Emerald's backend dependencies up to `Emerald\node_modules` (npm workspaces), which
would not be present in the package. Installing into staging produces a self-contained
`node_modules` with production dependencies only.

**Step 8 bakes two addresses into the LiveEdit bundle.** The LiveEdit UI dials Emerald directly for
the WebRTC preview and monitor, and Vite compiles those URLs into the JavaScript. They are the only
build-time setting that cannot be changed after installation:

```powershell
.\Installer\build\build-installer.ps1 -Version 1.1.0 `
    -EmeraldApiBaseUrl     http://10.0.0.32:5000 `
    -EmeraldMonitorBaseUrl http://10.0.0.32:5173
```

Defaults are loopback, which is right when everything runs on one machine. During this step a
temporary `.env.production.local` is written into `Emerald\LiveEdit\frontend` and removed again
afterwards — it outranks the checked-in `.env`, which is what stops a developer's LAN addresses
leaking into a shipped bundle.

## 5. All options

| Parameter | Default | Purpose |
| --- | --- | --- |
| `-Version` | `1.0.0` | Installer filename, Add/Remove Programs entry, `build-info.json` |
| `-EmeraldApiBaseUrl` | `http://127.0.0.1:5000` | Compiled into the LiveEdit bundle |
| `-EmeraldMonitorBaseUrl` | `http://127.0.0.1:5173` | Compiled into the LiveEdit bundle |
| `-CaptureServicePath` | `..\DeltacastCaptureService` | Where the capture service repository is |
| `-MediaMtxPath` | `..\MediaMtx` | Where `mediamtx.exe` is |
| `-FfmpegBinDir` | `C:\ffmpeg\bin` | Which FFmpeg build to ship |
| `-NodeExe` | first on `PATH` | Which Node runtime to ship |
| `-IsccPath` | auto-detected | Inno Setup compiler |
| `-SkipNpmInstall` | off | Reuse the staged `node_modules` |
| `-SkipFrontendBuild` | off | Reuse the existing `dist` folders |
| `-SkipWebView2Bootstrapper` | off | Do not download or ship the WebView2 bootstrapper |
| `-StageOnly` | off | Build the payload, skip Inno Setup |

## 6. Iterating

Changing the launcher, the service map, or the docs does not need a full rebuild:

```powershell
.\Installer\build\build-installer.ps1 -SkipNpmInstall -SkipFrontendBuild
```

Faster still, skip compression entirely and run the staged tree directly:

```powershell
.\Installer\build\build-installer.ps1 -StageOnly -SkipNpmInstall -SkipFrontendBuild
.\Installer\stage\Launcher\EmeraldLauncher.exe
```

The staged tree behaves exactly like an installed copy, because everything resolves relative to the
launcher's own folder — `Installer\stage\` stands in for the install directory and
`Installer\stage\config\launcher.config.json` for the installed config. This is the quickest way to
test a change to the service map or a launcher fix.

## 7. Verifying a build

```powershell
powershell -ExecutionPolicy Bypass -File Installer\build\test-suite.ps1
```

It starts the launcher against the staged payload, waits for all five services, exercises every
port, API and proxy path, opens both application windows and checks they render their UI, then
**kills the launcher outright** — not a clean quit — to confirm the job object takes the whole
process tree down with it and releases every port. Results are written to
[TEST-REPORT.md](TEST-REPORT.md).

It uses its own data directory under `%TEMP%`, so an installed copy's recordings are untouched. But
it uses the real ports and the launcher is single-instance, so **quit any running suite or dev
server first** — the script checks both up front and stops with a clear message rather than letting
every later check fail for one hidden reason.

To test an installed copy instead of the staged tree:

```powershell
.\Installer\build\test-suite.ps1 -AppRoot "C:\Program Files\Emerald Deltacast Suite"
```

## 8. Release checklist

1. Commit the source changes. **The build output is deliberately not committed** — `Installer\stage\`
   and `Installer\*.exe` are in `.gitignore`. The compiled installer is ~470 MB, well past GitHub's
   100 MB per-file hard limit; publish it as a release asset (or to a file share), not in git.
2. Pick the version. It appears in the filename, in Add/Remove Programs and in `build-info.json`,
   and Windows compares it when upgrading — so it must go up.
3. Build with that version, from a clean tree if the dependency trees have changed:
   ```powershell
   Remove-Item -Recurse -Force Installer\stage
   .\Installer\build\build-installer.ps1 -Version 1.2.0
   ```
4. Run `test-suite.ps1` and confirm it is green. Commit the regenerated `TEST-REPORT.md`.
5. Sign the launcher and the installer (see below).
6. Install it on a clean machine, not only the build machine — that is the only way to catch a
   missing prerequisite, since the build machine has all of them by definition.
7. Publish the `.exe` and tag the commit.

## 9. Signing

The installer is unsigned as built, so SmartScreen warns on first run. For production, sign the
launcher **before** packaging and the installer after:

```powershell
$sign = "C:\Program Files (x86)\Windows Kits\10\bin\x64\signtool.exe"

# 1. Stage without compressing, then sign the launcher inside the payload
.\Installer\build\build-installer.ps1 -Version 1.2.0 -StageOnly
& $sign sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a `
    Installer\stage\Launcher\EmeraldLauncher.exe

# 2. Package the signed payload
.\Installer\build\build-installer.ps1 -Version 1.2.0 -SkipNpmInstall -SkipFrontendBuild

# 3. Sign the installer itself
& $sign sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a `
    Installer\EmeraldDeltacastSuite-Setup-1.2.0.exe
```

## 10. When the build fails

| Message | Cause |
| --- | --- |
| `node.exe was not found on PATH` | Node missing, or PATH not refreshed after installing it |
| `Node vX is too old` | The Emerald backend needs Node 20+ |
| `DeltacastCaptureService.csproj was not found` | The capture service is not beside the repository — clone it, or pass `-CaptureServicePath` |
| `mediamtx.exe was not found` | Same for MediaMTX and `-MediaMtxPath` |
| `Inno Setup 6 (ISCC.exe) was not found` | Not installed, or installed per-user where auto-detection missed it — pass `-IsccPath` |
| `No ffmpeg.exe under ...` | Point `-FfmpegBinDir` at a real FFmpeg `bin` folder |
| `npm error code ENOSPC` / `NU1900 ... not enough space on the disk` | The **system** drive is full, even if the build drive is not. npm and NuGet cache to `%LOCALAPPDATA%`, and MSBuild uses `%TEMP%` — see below |
| `npm install failed with exit code ...` | Usually network or a native module failing to build; the npm output is directly above |
| `... 'BEGIN' expected` from ISCC | A Pascal Script error in `setup.iss`. Note it has no local `const` sections — declare constants at unit scope |
| ISCC exits 2 with no message | Seen once, transiently; re-running the same command succeeded. Suspect an antivirus scanner holding the freshly written output file |

Every external command is checked for a non-zero exit code, so a failure stops the build rather than
quietly producing a package with half a dependency tree in it.

### Building when the system drive is full

The staging tree and the output go to whichever drive the repository is on, but the toolchain still
writes to the system drive: npm and NuGet cache under `%LOCALAPPDATA%`, and MSBuild and Inno Setup
use `%TEMP%`. A full `C:` therefore fails the build even with hundreds of gigabytes free where the
repository lives. Redirect all three for the session:

```powershell
$env:TEMP = "I:\build-temp"; $env:TMP = $env:TEMP
$env:npm_config_cache = "I:\build-temp\npm-cache"
New-Item -ItemType Directory -Force -Path $env:TEMP, $env:npm_config_cache | Out-Null

.\Installer\build\build-installer.ps1 -Version 1.2.0
```

This is a way round a full disk for one build, not a fix for one — the redirected cache starts empty,
so that build re-downloads every npm package. Free space on the system drive properly when you can.

## 11. What ends up in the package

The staging tree becomes the install directory verbatim, with one exception:
`config\launcher.config.json` is installed **twice** — once as `launcher.config.default.json`, always
overwritten, and once under its real name with Inno's `onlyifdoesntexist` flag. That is what lets an
operator's edits (LAN addresses, ports, a disabled capture service) survive an upgrade while still
giving them the new defaults to compare against.

`build-info.json` at the install root records the version, build date, build machine, the bundled
Node version and the two addresses compiled into LiveEdit — the first thing to ask for in a bug
report.
