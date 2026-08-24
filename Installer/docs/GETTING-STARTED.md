# Emerald Deltacast Suite — Getting Started

This is the operator's guide: how to install the suite, start it, and reach the two web UIs. For
what each setting does see [CONFIGURATION.md](CONFIGURATION.md); when something will not start, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## What gets installed

Two desktop applications:

- **Emerald Capture** — capture, recording and playout
- **LiveEdit** — timeline editing and rendering

Each opens in its own window, with its own taskbar entry and icon. No browser is involved: the UI
is hosted inside the application by the Edge WebView2 runtime, so there is no address bar, no tabs
and no bookmarks around a broadcast control surface.

Behind them sits the **Emerald Deltacast Suite** control panel, which runs and supervises five
background services:

| Service | What it does | Port |
| --- | --- | --- |
| Deltacast Capture Service | SDI capture and playout over the Deltacast board | 5055 |
| Emerald Backend | Recording, export, RTMP ingest, WebRTC preview (starts MediaMTX) | 5000 |
| Emerald Frontend | Serves the Emerald UI shown in the Emerald Capture window | 5173 |
| LiveEdit Backend | Timeline editing, proxy generation, rendering | 4123 |
| LiveEdit Frontend | Serves the UI shown in the LiveEdit window | 5174 |

Node.js, the .NET runtime, FFmpeg and MediaMTX are all bundled. **Nothing needs to be installed
first** except the Deltacast board driver, and that is only needed for SDI capture — Emerald and
LiveEdit run fine without it.

The one component that is not bundled is Microsoft's **Edge WebView2 runtime**, which draws the two
application windows. It is a Windows component and is already present on any current Windows 10 or
11 machine; on the rare machine without it, setup installs it (that step needs internet access).

## Requirements

- Windows 10 version 1809 or later, 64-bit (Windows 11 and Server 2019+ also work)
- Administrator rights to run the installer (it writes to Program Files and adds firewall rules)
- About 2.5 GB of free disk space for the installation, plus room for recordings
- For SDI: a Deltacast board with its VideoMaster driver installed

## Install

1. Run `EmeraldDeltacastSuite-Setup-<version>.exe` and accept the elevation prompt.
2. Read the third-party licence notices (mainly FFmpeg's) and continue.
3. Choose an install folder, or accept `C:\Program Files\Emerald Deltacast Suite`.
4. Pick the optional tasks:
   - **Desktop shortcuts for Emerald Capture and LiveEdit** — on by default.
   - **Start automatically when I sign in** — recommended for a dedicated broadcast machine. The
     suite starts minimised to the notification area.
   - **Allow other machines on this network to reach the web UIs** — opens TCP 5173, 5174 and 8889
     inbound. Leave it off for a standalone machine.
5. Finish. Tick *Open Emerald Capture now* to launch it straight away.

You get three Start menu entries: **Emerald Capture**, **LiveEdit**, and the **Control Panel**.

## First run

Opening either application starts the whole suite if it is not already running — you do not have to
open the control panel first. The window shows a "waiting for the suite to finish starting" screen
while the five services come up in order, each waiting for the one before it to answer its health
check. Cold start takes roughly 10–20 seconds; the UI appears as soon as its service is ready.

To watch that happen in detail, open the control panel from the Start menu or the notification
area. It lists the five services with live status:

- **Green rows** are running.
- **Amber** means still starting.
- **Red** means the service failed — select its row to read the log at the bottom of the window.

On a machine with no Deltacast board, **Deltacast Capture Service will show red and that is
expected**. It is marked optional, so the rest of the suite carries on. Everything except SDI
capture and playout works.

Once the rows are green, the **Open Emerald Capture** and **Open LiveEdit** buttons in the control
panel header — and the same two entries in the tray icon's right-click menu — bring up the
application windows. Clicking one while its window is already open raises that window rather than
opening a second copy.

## Inside an application window

The window is the UI and nothing else. A few keys are wired up because there is no browser menu to
fall back on:

| Key | Does |
| --- | --- |
| `F5` | Reload the UI |
| `F11` | Full screen on / off (`Esc` also leaves full screen) |
| `F12` | Developer tools, for support |
| `Ctrl` + mouse wheel | Zoom |

Each window remembers its size, position and monitor between sessions. If the service behind a
window stops, the window says so and offers a **Retry** button instead of showing a browser error
page.

The UIs are still ordinary web pages served locally, so you can open <http://127.0.0.1:5173> or
<http://127.0.0.1:5174> in a browser as well — useful from a second machine, or for a quick
side-by-side view.

## Day-to-day use

| I want to… | Do this |
| --- | --- |
| Open a UI | Its desktop or Start menu shortcut, or the control panel's header buttons |
| Close a UI without stopping anything | Close that application window — the services keep running |
| Hide the control panel | Close the window — the suite keeps running in the notification area |
| Bring it back | Double-click the tray icon, or right-click → *Open Control Panel* |
| Change a setting | **Settings…** in the control panel, or *Emerald Deltacast Suite Settings* in the Start menu |
| Restart one service | Select its row, click **Restart Selected** |
| Stop everything but stay open | **Stop All** |
| Shut the suite down completely | **Quit Suite**, or tray → *Quit Suite* |
| Read a service's full log | **Open Log Folder** |

Closing a window — an application window or the control panel — never stops a service. That is
deliberate, so an accidental click on the X cannot take a live broadcast off air. Only **Quit
Suite** stops things, and it closes the two application windows first so you are not left looking
at a UI whose backend has just gone.

If a service crashes, the launcher restarts it automatically up to three times before giving up
and marking the row red.

## Changing settings

**Settings…** in the control panel opens one screen covering all five services: the capture
service's `appsettings.json` (board and channel indexes, resolution, frame rate) and each service's
own settings — ports, storage paths, the database, FFmpeg and MediaMTX locations.

The same screen is in the Start menu as **Emerald Deltacast Suite Settings**, which opens it without
starting anything — the way in when a bad setting is what is stopping the suite from starting.

Saving prompts for administrator rights (the files live under Program Files), keeps the previous
version as `.bak`, and offers to restart the suite so the change takes effect. Full reference:
[CONFIGURATION.md](CONFIGURATION.md).

## Where your files live

Everything the suite writes goes under `C:\ProgramData\EmeraldDeltacastSuite`:

```
Recordings\      full-quality recordings
Exports\         clips exported from the media browser
EditCaptures\    segmented edit-capture material
db\              emerald.sqlite — sessions, recordings, timecode log
LiveEdit\        LiveEdit projects and its .media-cache (proxies, renders)
logs\            one .log per service, plus the previous run as .log.1
```

Nothing is written into the install folder at runtime, so the suite works correctly when signed in
as a standard (non-administrator) user.

**Uninstalling leaves this folder alone.** Your recordings survive an uninstall or a reinstall; if
you really want them gone, delete the folder by hand.

## Using it from another machine

By default everything is loopback-only. To let a second machine on the LAN open the UIs:

1. Tick the firewall task during install (or add the rules later — see
   [CONFIGURATION.md](CONFIGURATION.md#network-access)).
2. Set `MEDIAMTX_PUBLIC_HOST` in `config\launcher.config.json` to this machine's LAN IP address,
   otherwise the WebRTC preview will not play on the remote browser.
3. Browse to `http://<this-machine-ip>:5173` and `:5174`.

The LiveEdit UI additionally has the Emerald address compiled into its bundle at build time. If
LiveEdit runs on a different machine from Emerald, rebuild the installer with
`-EmeraldApiBaseUrl` / `-EmeraldMonitorBaseUrl` pointed at the Emerald machine — see
[BUILDING.md](BUILDING.md).

## Upgrading

Run the newer installer over the top. It offers to close a running suite first, replaces the
program files, and **keeps your `config\launcher.config.json` exactly as you edited it**. The
version that shipped with the new build is written alongside it as `launcher.config.default.json`
so you can diff the two.

That protection cuts both ways: a release that adds a **new** setting cannot add it to your file
either. After upgrading, compare the two:

```powershell
cd "C:\Program Files\Emerald Deltacast Suite\config"
Compare-Object (Get-Content launcher.config.json) (Get-Content launcher.config.default.json)
```

If you have not customised anything, the simplest course is to take the new file wholesale:

```powershell
Copy-Item launcher.config.default.json launcher.config.json -Force
```

A missing new setting usually shows up as one service failing with a path error in its log — see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).
