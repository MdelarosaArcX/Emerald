# Test Report

Produced by `Installer\build\test-suite.ps1`. It starts the launcher against a built payload,
exercises every service, port, API and proxy path the product depends on, then kills the launcher
outright to confirm the process tree dies with it.

| | |
| --- | --- |
| Run | 2026-08-21 11:10:46 +10:00 |
| Machine | SYDNEYIGNIS2 (Microsoft Windows 10 Pro) |
| Payload | `I:\EmeraldDeltacast\Installer\stage` |
| Version | 1.1.0 built 2026-08-21T11:04:27+10:00 |
| Node | v22.22.0 (bundled) |
| Result | **66 passed, 0 failed** |

## Scope

**Covered.** Every service starts and answers its health endpoint; every port binds; the
Emerald and LiveEdit APIs respond; both frontends serve their built bundles, handle
single-page-app deep links and proxy their backend paths (including the socket.io
handshake); Emerald Capture and LiveEdit each open as a native WebView2 window that
renders its UI, with no browser process involved and no duplicate window on a second
launch; all runtime data is written outside the install folder; each service logs; and
a hard kill of the launcher takes the whole process tree, ffmpeg and mediamtx included,
down with it and releases every port.

**Not covered.** This script exercises the built payload, which is the same tree the
installer packages, but it does not run the installer executable itself - that needs an
elevated session. It also does not exercise SDI capture or playout end to end, which
needs a Deltacast board with an SDI-capable channel and live signal; the capture service is
verified as far as starting, reading its configuration and serving its control surface.

## Pre-flight

| Result | Check | Detail |
| --- | --- | --- |
| PASS | No other launcher instance is running |  |
| PASS | All suite ports free before start |  |

## Startup

| Result | Check | Detail |
| --- | --- | --- |
| PASS | Emerald Backend answers its health check | http://127.0.0.1:5000/api/system/status |
| PASS | Emerald Frontend answers its health check | http://127.0.0.1:5173/ |
| PASS | LiveEdit Backend answers its health check | http://127.0.0.1:4123/api/status |
| PASS | LiveEdit Frontend answers its health check | http://127.0.0.1:5174/ |
| PASS | Deltacast Capture (optional) reachable | up |

## Ports

| Result | Check | Detail |
| --- | --- | --- |
| PASS | TCP 5000 listening (Emerald Backend) |  |
| PASS | TCP 5173 listening (Emerald Frontend) |  |
| PASS | TCP 4123 listening (LiveEdit Backend) |  |
| PASS | TCP 5174 listening (LiveEdit Frontend) |  |
| PASS | TCP 5055 (Deltacast Capture, optional) | listening |
| PASS | TCP 8554 listening (MediaMTX) | started by the Emerald backend |
| PASS | TCP 8889 listening (MediaMTX) | started by the Emerald backend |

## Emerald API

| Result | Check | Detail |
| --- | --- | --- |
| PASS | GET /api/system/status returns 200 | HTTP 200 |
| PASS | system status is JSON | {"backend":"ok","redis":{"configured":false,"url":"redis://127.0.0.1:6379","status":"not_connected"},"queues":{"name":"e |
| PASS | GET /api/system/databases returns 200 | SQLite database opened |
| PASS | GET /api/obs-recordings responds | HTTP 200 |
| PASS | GET /api/recording-sessions responds | HTTP 200 |
| PASS | GET /api/recordings/exports responds | HTTP 200 |
| PASS | GET /api/edit-capture/status responds | HTTP 200 |
| PASS | GET /api/webrtc-preview/status responds | HTTP 200 |

## LiveEdit API

| Result | Check | Detail |
| --- | --- | --- |
| PASS | GET /api/status returns 200 | HTTP 200 |
| PASS | GET /api/project responds | HTTP 200 |

## Frontend

| Result | Check | Detail |
| --- | --- | --- |
| PASS | Emerald serves index.html | HTTP 200 |
| PASS | Emerald serves its JS bundle | /assets/index-C4YX9xG6.js |
| PASS | Emerald fingerprinted assets are cacheable | Cache-Control: public, max-age=31536000, immutable |
| PASS | Emerald SPA fallback serves index.html | HTTP 200 |
| PASS | Emerald rejects path traversal | HTTP 200 |
| PASS | LiveEdit serves index.html | HTTP 200 |
| PASS | LiveEdit serves its JS bundle | /assets/index-B1PA9hy1.js |
| PASS | LiveEdit fingerprinted assets are cacheable | Cache-Control: public, max-age=31536000, immutable |
| PASS | LiveEdit SPA fallback serves index.html | HTTP 200 |
| PASS | LiveEdit rejects path traversal | HTTP 200 |

## Proxy

| Result | Check | Detail |
| --- | --- | --- |
| PASS | Emerald frontend proxies /api to the backend | HTTP 200, JSON not HTML |
| PASS | LiveEdit frontend proxies /api to the backend | HTTP 200, JSON not HTML |
| PASS | LiveEdit frontend proxies /socket.io | socket.io handshake returned a session id |

## Data

| Result | Check | Detail |
| --- | --- | --- |
| PASS | logs created under the data directory | C:\Users\SYDNEY~1\AppData\Local\Temp\EmeraldSuiteTestData\logs |
| PASS | Recordings created under the data directory | C:\Users\SYDNEY~1\AppData\Local\Temp\EmeraldSuiteTestData\Recordings |
| PASS | Exports created under the data directory | C:\Users\SYDNEY~1\AppData\Local\Temp\EmeraldSuiteTestData\Exports |
| PASS | EditCaptures created under the data directory | C:\Users\SYDNEY~1\AppData\Local\Temp\EmeraldSuiteTestData\EditCaptures |
| PASS | db created under the data directory | C:\Users\SYDNEY~1\AppData\Local\Temp\EmeraldSuiteTestData\db |
| PASS | LiveEdit created under the data directory | C:\Users\SYDNEY~1\AppData\Local\Temp\EmeraldSuiteTestData\LiveEdit |
| PASS | SQLite database created outside Program Files | C:\Users\SYDNEY~1\AppData\Local\Temp\EmeraldSuiteTestData\db\emerald.sqlite |

## Logs

| Result | Check | Detail |
| --- | --- | --- |
| PASS | Emerald Backend wrote a log file | 1 KB |
| PASS | Emerald Backend log is free of errors | no errors logged |
| PASS | Emerald Frontend wrote a log file | 0.4 KB |
| PASS | Emerald Frontend log is free of errors | no errors logged |
| PASS | LiveEdit Backend wrote a log file | 7.7 KB |
| PASS | LiveEdit Backend log is free of errors | no errors logged |
| PASS | LiveEdit Frontend wrote a log file | 0.4 KB |
| PASS | LiveEdit Frontend log is free of errors | no errors logged |
| PASS | Deltacast Capture wrote a log file | 1181.9 KB |

## Configuration

| Result | Check | Detail |
| --- | --- | --- |
| PASS | Capture service reads appsettings.json from the install folder | content root: I:\EmeraldDeltacast\Installer\stage\DeltacastCaptureService |

## Desktop apps

| Result | Check | Detail |
| --- | --- | --- |
| PASS | Emerald Capture has its own icon | emerald-capture.ico |
| PASS | LiveEdit has its own icon | liveedit.ico |
| PASS | Emerald Capture opens a native window | window title: 'Emerald Capture - Emerald Streaming' |
| PASS | Emerald Capture loads its UI in the window | document title 'Emerald Streaming' reached the window title |
| PASS | LiveEdit opens a native window | window title: 'LiveEdit - Dashboard · Emerald Live Edit' |
| PASS | LiveEdit loads its UI in the window | document title 'Emerald Live Edit' reached the window title |
| PASS | Windows are WebView2-hosted, not a browser | 12 msedgewebview2 host process(es) |
| PASS | No browser was launched for the UIs | no browser process started by opening the apps |
| PASS | Re-launching an app raises the existing window | second instance exited instead of opening a duplicate |

## Processes

| Result | Check | Detail |
| --- | --- | --- |
| PASS | Service processes running under the launcher | 7 process(es): DeltacastCaptureService, ffmpeg, mediamtx, node |

## Shutdown

| Result | Check | Detail |
| --- | --- | --- |
| PASS | Job object killed the whole process tree | no orphaned node/ffmpeg/mediamtx processes |
| PASS | All suite ports released | 5000, 5055, 5173, 5174, 4123, 8554, 8889 all free |

