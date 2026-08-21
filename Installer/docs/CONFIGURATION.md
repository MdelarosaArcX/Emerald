# Configuration Reference

Everything the launcher knows about the five services lives in one file:

```
<install folder>\config\launcher.config.json
```

Edit it with any text editor (as an administrator, since it is under Program Files), then restart
the suite from the tray icon. The copy that shipped with the current build is kept beside it as
`launcher.config.default.json`; an upgrade refreshes that file but never touches yours.

## How paths are written

Three substitutions are applied to every path, argument and environment value in the file:

| Token | Expands to | Example |
| --- | --- | --- |
| `{APP}` | The install folder | `C:\Program Files\Emerald Deltacast Suite` |
| `{DATA}` | The `dataDirectory` value below | `C:\ProgramData\EmeraldDeltacastSuite` |
| `%VAR%` | Any Windows environment variable | `%PROGRAMDATA%` |

Because this is JSON, every backslash in a path must be doubled: `"{DATA}\\Recordings"`.

JSON has no comment syntax, so notes in the file are written as keys starting with `//`. The
launcher skips those keys — including inside an `environment` block — so they never reach a
service as a variable.

## Top-level keys

```jsonc
{
  "dataDirectory": "%PROGRAMDATA%\\EmeraldDeltacastSuite",
  "apps": [ { "id": "emerald", "title": "Emerald Capture", "url": "http://127.0.0.1:5173", ... } ],
  "services": [ ... ]
}
```

- **`dataDirectory`** — the writable root for recordings, exports, the database and logs. Point it
  at a fast dedicated volume (`"D:\\EmeraldData"`) on a recording machine. The folder and its
  subfolders are created at startup if missing.
- **`apps`** — the suite's desktop applications; see below.
- **`services`** — the background processes the control panel supervises.

## The `apps` block

Each entry is one desktop window, opened by running `EmeraldLauncher.exe --app <id>`. The Start
menu and desktop shortcuts do exactly that.

| Key | Meaning |
| --- | --- |
| `id` | Command-line name (`--app emerald`); also names the window's WebView2 profile folder |
| `title` | Window and taskbar title |
| `label` | Shorter text for the control panel button and tray menu; falls back to `title` |
| `url` | The locally served UI to display |
| `icon` | Icon file name, resolved next to `EmeraldLauncher.exe` |
| `width` / `height` | Window size the first time it opens |
| `maximized` | Start maximised (default `true`) |
| `startupTimeoutSeconds` | How long the window waits for its service before offering **Retry** |

After the first run, the remembered size and position win over `width`/`height`/`maximized`. That
state lives in `%LOCALAPPDATA%\EmeraldDeltacastSuite\WebView2\<id>\window.json`; delete the file to
go back to the configured defaults.

Changing an app's `url` — to point a window at Emerald on another machine, say — is enough; nothing
else needs to match. Adding a third entry gives you a third application window and a third button
in the control panel, though only entries with a shortcut are reachable from the Start menu.

## Per-service keys

| Key | Meaning |
| --- | --- |
| `id` | Internal name; also the log file name (`logs\<id>.log`) |
| `name` | Shown in the control panel |
| `executable` | Program to run |
| `arguments` | Command line; quote any path containing spaces |
| `workingDirectory` | Created if missing before the service starts |
| `healthUrl` | Polled once a second until it answers; blank means "assume started" |
| `port` | Displayed in the UI only — change the real port in `environment` |
| `startupOrder` | Ascending; each service must pass its health check before the next starts |
| `healthTimeoutSeconds` | How long to wait before declaring the start failed |
| `autoRestart` | Restart automatically after an unexpected exit (three attempts) |
| `required` | `false` means a failure is reported but does not interrupt the rest of the startup |
| `environment` | Variables set for that process only |

A health check treats any HTTP response below 500 as alive, so a route that moved does not strand
a healthy service.

## Common changes

### Running without a Deltacast board

The capture service already ships with `"required": false`, so it fails visibly and the rest of the
suite continues. To stop it being started at all, set `"autoRestart": false` and give it a large
`startupOrder`, or delete its entry from `services`.

To exercise the capture pipeline with no hardware, add its simulation switch instead:

```jsonc
"environment": {
  "Capture__Simulate": "true"
}
```

`Capture__Simulate` swaps the SDI board for synthetic test-pattern frames. Double underscore is
.NET's separator for nested configuration keys, so any value in the service's `appsettings.json`
can be overridden the same way — `Capture__FrameRate`, `Http__Port`, `Transmit__ChannelIndex`.

### Changing a port

Two places must agree: the service's own port variable, and whatever dials it.

To move the Emerald UI from 5173 to 8080, edit the `emerald-frontend` service:

```jsonc
"port": 8080,
"healthUrl": "http://127.0.0.1:8080/",
"environment": { "SERVE_PORT": "8080", ... }
```

then update the matching entry in `links`. Moving a *backend* port additionally means updating the
frontend's `PROXY_TARGET`, and for LiveEdit its `CORS_ORIGIN`.

### Storage limits

On the `emerald-backend` service:

```jsonc
"RECORDING_SIZE_LIMIT": "200gb",
"STORAGE_SIZE_LIMIT": "200gb",
"STORAGE_QUOTA_ENFORCE": "true"
```

`STORAGE_QUOTA_ENFORCE` set to `false` reports usage without refusing new recordings.

### Timecode master

The backend reads timecode from a Timecode System generator over HTTP. Unset, it falls back to its
own wall clock and flags recordings as free-run:

```jsonc
"EMERALD_TIMECODE_MASTER_URL": "http://10.0.0.33:8888"
```

Point it at the machine running the **Generator**, not a Reader.

### Network access

The firewall rules the installer can add are exactly these three, and they can be added later from
an elevated prompt:

```powershell
netsh advfirewall firewall add rule name="Emerald Deltacast Suite - Emerald UI"      dir=in action=allow protocol=TCP localport=5173
netsh advfirewall firewall add rule name="Emerald Deltacast Suite - LiveEdit UI"     dir=in action=allow protocol=TCP localport=5174
netsh advfirewall firewall add rule name="Emerald Deltacast Suite - WebRTC preview"  dir=in action=allow protocol=TCP localport=8889
```

The API ports (5000 and 4123) stay closed deliberately: each frontend proxies to its own backend
over loopback, so nothing outside the machine needs to reach them.

For a remote browser to play the WebRTC preview, `MEDIAMTX_PUBLIC_HOST` must be this machine's
actual LAN IP — it is baked into an absolute URL the remote browser dials directly, so `0.0.0.0`
and `127.0.0.1` do not work there:

```jsonc
"MEDIAMTX_PUBLIC_HOST": "10.0.0.32"
```

### Using an external MySQL database

Instead of the bundled SQLite file:

```jsonc
"DATABASE_TYPE": "mysql",
"DATABASE_HOST": "10.0.0.40",
"DATABASE_PORT": "3306",
"DATABASE_NAME": "emerald",
"DATABASE_USER": "emerald",
"DATABASE_PASSWORD": "..."
```

## Full environment variable reference

### Emerald backend

| Variable | Default in the shipped config | Purpose |
| --- | --- | --- |
| `EMERALD_URLS` | `http://0.0.0.0:5000` | Listen address |
| `EMERALD_RECORDINGS_PATH` | `{DATA}\Recordings` | Recording output |
| `EMERALD_EXPORTS_PATH` | `{DATA}\Exports` | Exported clips |
| `EMERALD_EDIT_CAPTURE_PATH` | `{DATA}\EditCaptures` | Segmented edit capture |
| `EMERALD_BACKUP_PATH` | *(unset)* | Secondary copy target |
| `DATABASE_TYPE` / `DATABASE_PATH` | `sqlite` / `{DATA}\db\emerald.sqlite` | Metadata store |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Bundled build | Media tools |
| `MEDIAMTX_PATH` / `MEDIAMTX_CONFIG_PATH` | Bundled build | RTSP/WebRTC server the backend starts |
| `MEDIAMTX_PUBLIC_HOST` | `127.0.0.1` | Host baked into WHEP URLs |
| `MEDIAMTX_RTSP_PORT` / `MEDIAMTX_WHEP_PORT` | `8554` / `8889` | MediaMTX ports |
| `DELTACAST_TX_SERVICE_URL` | `http://127.0.0.1:5055` | Capture service control surface |
| `EMERALD_RTMP_PORT` / `EMERALD_RTMP_BIND` | `1935` / all | OBS ingest |
| `EMERALD_TIMECODE_MASTER_URL` | *(unset)* | Timecode generator |
| `RECORDING_SIZE_LIMIT`, `STORAGE_SIZE_LIMIT`, `STORAGE_QUOTA_ENFORCE` | `200gb`, `200gb`, `true` | Quota |
| `EMERALD_LOG_LEVEL` | *(unset)* | Log verbosity |

### LiveEdit backend

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4123` | Listen port |
| `CORS_ORIGIN` | `http://127.0.0.1:5174` | Allowed browser origin |
| `EMERALD_BACKEND_URL` | `http://127.0.0.1:5000` | Where media metadata is pulled from |
| `EMERALD_RECORDINGS_PATH` | `{DATA}\Recordings` | Read segments off disk instead of over HTTP |
| `EMERALD_EXPORTS_PATH` | `{DATA}\Exports` | Same shortcut for exported clips |
| `MEDIA_ASSET_SYNC_INTERVAL_MS` | `10000` | Media browser refresh interval |

Its working directory is `{DATA}\LiveEdit` because LiveEdit writes its `.media-cache` (proxies and
renders) relative to the working directory. Leave it pointing somewhere writable.

### Frontend static servers

Both UIs are served by `runtime\static-server.js`, configured entirely through the environment:

| Variable | Purpose |
| --- | --- |
| `SERVE_PORT` | Port to listen on |
| `SERVE_ROOT` | Folder holding the built `index.html` |
| `SERVE_HOST` | Bind address (`0.0.0.0` for LAN, `127.0.0.1` for loopback only) |
| `PROXY_TARGET` | Backend origin |
| `PROXY_PREFIXES` | Comma-separated paths forwarded to the backend, including websockets |

Removing a prefix from `PROXY_PREFIXES` does not produce an error — the path silently falls through
to the single-page-app fallback and returns `index.html`. If an API call starts returning HTML,
that is the first thing to check.
