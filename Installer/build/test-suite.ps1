# =============================================================================================
#  Emerald Deltacast Suite - end-to-end verification
#
#  Starts the launcher against the built payload, waits for all five services, then exercises
#  every port, endpoint and proxy path the product depends on. Finally it kills the launcher
#  outright - not a clean quit - to prove the job object takes the whole process tree with it,
#  including the ffmpeg and mediamtx grandchildren that would otherwise squat on the media ports.
#
#  Usage:
#      powershell -ExecutionPolicy Bypass -File Installer\build\test-suite.ps1
#      ... -AppRoot "C:\Program Files\Emerald Deltacast Suite"   test an installed copy instead
#      ... -KeepRunning                                          leave the suite up afterwards
#
#  The test uses the real ports, so quit any running suite or dev server first.
# =============================================================================================

[CmdletBinding()]
param(
    [string]$AppRoot = "",
    [string]$DataDirectory = "",
    [string]$ReportPath = "",
    [switch]$KeepRunning
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$installerRoot = Split-Path -Parent $PSScriptRoot
if (-not $AppRoot) { $AppRoot = Join-Path $installerRoot "stage" }
if (-not $DataDirectory) { $DataDirectory = Join-Path $env:TEMP "EmeraldSuiteTestData" }
if (-not $ReportPath) { $ReportPath = Join-Path $installerRoot "docs\TEST-REPORT.md" }

$configPath = Join-Path $AppRoot "config\launcher.config.json"
$launcherExe = Join-Path $AppRoot "Launcher\EmeraldLauncher.exe"
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result {
    param([string]$Area, [string]$Name, [bool]$Passed, [string]$Detail = "")
    $results.Add([pscustomobject]@{ Area = $Area; Name = $Name; Passed = $Passed; Detail = $Detail })
    $mark = if ($Passed) { "PASS" } else { "FAIL" }
    $colour = if ($Passed) { "Green" } else { "Red" }
    Write-Host ("  [{0}] {1}{2}" -f $mark, $Name, $(if ($Detail) { " - $Detail" } else { "" })) -ForegroundColor $colour
}

function Write-Step { param([string]$Message) Write-Host "`n=== $Message ===" -ForegroundColor Cyan }

# Any HTTP answer is a result worth asserting on, including a 4xx/5xx, so failures are reported as
# status codes rather than as terminating errors.
function Invoke-Probe {
    param([string]$Url, [int]$TimeoutSec = 10)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        return [pscustomobject]@{ Ok = $true; StatusCode = [int]$response.StatusCode; Content = $response.Content; Headers = $response.Headers; Error = "" }
    }
    catch [System.Net.WebException] {
        $webResponse = $_.Exception.Response
        if ($webResponse) {
            $reader = New-Object System.IO.StreamReader($webResponse.GetResponseStream())
            $body = $reader.ReadToEnd()
            $reader.Close()
            return [pscustomobject]@{ Ok = $false; StatusCode = [int]$webResponse.StatusCode; Content = $body; Headers = $null; Error = $_.Exception.Message }
        }
        return [pscustomobject]@{ Ok = $false; StatusCode = 0; Content = ""; Headers = $null; Error = $_.Exception.Message }
    }
    catch {
        return [pscustomobject]@{ Ok = $false; StatusCode = 0; Content = ""; Headers = $null; Error = $_.Exception.Message }
    }
}

function Test-PortListening {
    param([int]$Port)
    $connections = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq $Port }
    return [bool]$connections
}

function Wait-ForUrl {
    param([string]$Url, [int]$TimeoutSeconds = 90)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $probe = Invoke-Probe -Url $Url -TimeoutSec 4
        if ($probe.StatusCode -gt 0 -and $probe.StatusCode -lt 500) { return $true }
        Start-Sleep -Milliseconds 1500
    }
    return $false
}

# ---------------------------------------------------------------------------------------------
Write-Step "Pre-flight"
# ---------------------------------------------------------------------------------------------
foreach ($required in @($launcherExe, $configPath)) {
    if (-not (Test-Path $required)) { throw "Not found: $required. Build the payload first (build-installer.ps1)." }
}
Write-Host "  App root : $AppRoot"
Write-Host "  Data dir : $DataDirectory"

# The launcher is single-instance by design, so a copy already running - typically an installed one
# whose control panel is still open - makes the test's own launcher exit on startup and every later
# check fail for the same hidden reason. Catch it here and say so.
$runningLaunchers = @(Get-Process -Name "EmeraldLauncher" -ErrorAction SilentlyContinue)
if ($runningLaunchers) {
    $paths = ($runningLaunchers | ForEach-Object { "PID $($_.Id): $($_.Path)" }) -join "; "
    throw "Emerald Deltacast Suite is already running, so a second launcher cannot start. Quit it from its tray icon first. Found $paths"
}
Add-Result "Pre-flight" "No other launcher instance is running" $true

$busyPorts = @(5000, 5055, 5173, 5174, 4123, 8554, 8889) | Where-Object { Test-PortListening -Port $_ }
if ($busyPorts) {
    throw "These ports are already in use: $($busyPorts -join ', '). Quit any running suite or dev server first."
}
Add-Result "Pre-flight" "All suite ports free before start" $true

# The launcher only ever reads {APP}\config\launcher.config.json, so redirecting the test's data
# away from the machine's real ProgramData folder means editing that file and putting it back.
$originalConfig = Get-Content -LiteralPath $configPath -Raw
$testConfig = $originalConfig -replace '"dataDirectory"\s*:\s*"[^"]*"', ('"dataDirectory": "' + $DataDirectory.Replace('\', '\\') + '"')
Set-Content -LiteralPath $configPath -Value $testConfig -Encoding utf8
Remove-Item -Recurse -Force $DataDirectory -ErrorAction SilentlyContinue

$launcher = $null
try {
    # -----------------------------------------------------------------------------------------
    Write-Step "Starting the suite"
    # -----------------------------------------------------------------------------------------
    $launcher = Start-Process -FilePath $launcherExe -ArgumentList "--minimized" -PassThru
    Write-Host "  Launcher PID $($launcher.Id)"

    $services = @(
        @{ Id = "emerald-backend";   Name = "Emerald Backend";   Port = 5000; Health = "http://127.0.0.1:5000/api/system/status"; Required = $true },
        @{ Id = "emerald-frontend";  Name = "Emerald Frontend";  Port = 5173; Health = "http://127.0.0.1:5173/";                  Required = $true },
        @{ Id = "liveedit-backend";  Name = "LiveEdit Backend";  Port = 4123; Health = "http://127.0.0.1:4123/api/status";        Required = $true },
        @{ Id = "liveedit-frontend"; Name = "LiveEdit Frontend"; Port = 5174; Health = "http://127.0.0.1:5174/";                  Required = $true },
        @{ Id = "deltacast-capture"; Name = "Deltacast Capture"; Port = 5055; Health = "http://127.0.0.1:5055/capture/status";    Required = $false }
    )

    foreach ($service in $services) {
        $up = Wait-ForUrl -Url $service.Health -TimeoutSeconds 120
        if ($service.Required) {
            Add-Result "Startup" "$($service.Name) answers its health check" $up $service.Health
        }
        else {
            # No SDI board on a build machine is the normal case, so this is recorded rather than
            # asserted: what matters is that the suite carried on without it.
            Add-Result "Startup" "$($service.Name) (optional) reachable" $true $(if ($up) { "up" } else { "not running - no Deltacast board; suite continued as designed" })
        }
    }

    # -----------------------------------------------------------------------------------------
    Write-Step "Ports"
    # -----------------------------------------------------------------------------------------
    foreach ($service in $services) {
        $listening = Test-PortListening -Port $service.Port
        if ($service.Required) {
            Add-Result "Ports" "TCP $($service.Port) listening ($($service.Name))" $listening
        }
        else {
            Add-Result "Ports" "TCP $($service.Port) ($($service.Name), optional)" $true $(if ($listening) { "listening" } else { "not listening - board absent" })
        }
    }
    foreach ($mediaPort in @(8554, 8889)) {
        $listening = Test-PortListening -Port $mediaPort
        Add-Result "Ports" "TCP $mediaPort listening (MediaMTX)" $listening "started by the Emerald backend"
    }

    # -----------------------------------------------------------------------------------------
    Write-Step "Emerald backend API"
    # -----------------------------------------------------------------------------------------
    $status = Invoke-Probe "http://127.0.0.1:5000/api/system/status"
    Add-Result "Emerald API" "GET /api/system/status returns 200" ($status.StatusCode -eq 200) "HTTP $($status.StatusCode)"
    Add-Result "Emerald API" "system status is JSON" ($status.Content -match '^\s*\{') ($status.Content.Substring(0, [Math]::Min(120, $status.Content.Length)))

    $databases = Invoke-Probe "http://127.0.0.1:5000/api/system/databases"
    Add-Result "Emerald API" "GET /api/system/databases returns 200" ($databases.StatusCode -eq 200) "SQLite database opened"

    foreach ($endpoint in @("/api/obs-recordings", "/api/recording-sessions", "/api/recordings/exports", "/api/edit-capture/status", "/api/webrtc-preview/status")) {
        $probe = Invoke-Probe "http://127.0.0.1:5000$endpoint"
        Add-Result "Emerald API" "GET $endpoint responds" ($probe.StatusCode -ge 200 -and $probe.StatusCode -lt 400) "HTTP $($probe.StatusCode)"
    }

    # -----------------------------------------------------------------------------------------
    Write-Step "LiveEdit backend API"
    # -----------------------------------------------------------------------------------------
    $liveStatus = Invoke-Probe "http://127.0.0.1:4123/api/status"
    Add-Result "LiveEdit API" "GET /api/status returns 200" ($liveStatus.StatusCode -eq 200) "HTTP $($liveStatus.StatusCode)"

    $projects = Invoke-Probe "http://127.0.0.1:4123/api/project"
    Add-Result "LiveEdit API" "GET /api/project responds" ($projects.StatusCode -ge 200 -and $projects.StatusCode -lt 400) "HTTP $($projects.StatusCode)"

    # -----------------------------------------------------------------------------------------
    Write-Step "Frontends"
    # -----------------------------------------------------------------------------------------
    foreach ($frontend in @(
            @{ Name = "Emerald";  Url = "http://127.0.0.1:5173" },
            @{ Name = "LiveEdit"; Url = "http://127.0.0.1:5174" })) {

        $index = Invoke-Probe $frontend.Url
        Add-Result "Frontend" "$($frontend.Name) serves index.html" ($index.StatusCode -eq 200 -and $index.Content -match '<div id="app"') "HTTP $($index.StatusCode)"

        # The built bundle is fingerprinted, so the asset name has to be read out of index.html
        # rather than guessed - which also proves the two files were staged together.
        if ($index.Content -match '(?:src|href)="(/assets/[^"]+\.js)"') {
            $assetUrl = $frontend.Url + $Matches[1]
            $asset = Invoke-Probe $assetUrl
            Add-Result "Frontend" "$($frontend.Name) serves its JS bundle" ($asset.StatusCode -eq 200) $Matches[1]
            $cacheHeader = if ($asset.Headers) { $asset.Headers["Cache-Control"] } else { "" }
            Add-Result "Frontend" "$($frontend.Name) fingerprinted assets are cacheable" ($cacheHeader -match "immutable") "Cache-Control: $cacheHeader"
        }
        else {
            Add-Result "Frontend" "$($frontend.Name) index.html references a JS bundle" $false "no /assets/*.js found in index.html"
        }

        # A deep link must return the app, not a 404, or vue-router never gets a chance to run.
        $deepLink = Invoke-Probe ($frontend.Url + "/some/client/side/route")
        Add-Result "Frontend" "$($frontend.Name) SPA fallback serves index.html" ($deepLink.StatusCode -eq 200 -and $deepLink.Content -match '<div id="app"') "HTTP $($deepLink.StatusCode)"

        # Directory traversal must not escape the served folder.
        $traversal = Invoke-Probe ($frontend.Url + "/%2e%2e/%2e%2e/config/launcher.config.json")
        $leaked = $traversal.Content -match 'dataDirectory'
        Add-Result "Frontend" "$($frontend.Name) rejects path traversal" (-not $leaked) "HTTP $($traversal.StatusCode)"
    }

    # -----------------------------------------------------------------------------------------
    Write-Step "Frontend to backend proxying"
    # -----------------------------------------------------------------------------------------
    # This is the half of Vite's dev server that a plain static host does not provide, so it is
    # the single most important thing to verify in a packaged build.
    $proxiedEmerald = Invoke-Probe "http://127.0.0.1:5173/api/system/status"
    Add-Result "Proxy" "Emerald frontend proxies /api to the backend" ($proxiedEmerald.StatusCode -eq 200 -and $proxiedEmerald.Content -match '^\s*\{') "HTTP $($proxiedEmerald.StatusCode), JSON not HTML"

    $proxiedLiveEdit = Invoke-Probe "http://127.0.0.1:5174/api/status"
    Add-Result "Proxy" "LiveEdit frontend proxies /api to the backend" ($proxiedLiveEdit.StatusCode -eq 200 -and $proxiedLiveEdit.Content -match '^\s*[\{\[]') "HTTP $($proxiedLiveEdit.StatusCode), JSON not HTML"

    # socket.io's polling handshake goes through the same proxy path its websocket upgrade will.
    $socketIo = Invoke-Probe "http://127.0.0.1:5174/socket.io/?EIO=4&transport=polling"
    Add-Result "Proxy" "LiveEdit frontend proxies /socket.io" ($socketIo.StatusCode -eq 200 -and $socketIo.Content -match '"sid"') "socket.io handshake returned a session id"

    # -----------------------------------------------------------------------------------------
    Write-Step "Writable data directories"
    # -----------------------------------------------------------------------------------------
    foreach ($relative in @("logs", "Recordings", "Exports", "EditCaptures", "db", "LiveEdit")) {
        $path = Join-Path $DataDirectory $relative
        Add-Result "Data" "$relative created under the data directory" (Test-Path $path) $path
    }
    $sqlite = Join-Path $DataDirectory "db\emerald.sqlite"
    Add-Result "Data" "SQLite database created outside Program Files" (Test-Path $sqlite) $sqlite

    # -----------------------------------------------------------------------------------------
    Write-Step "Service logs"
    # -----------------------------------------------------------------------------------------
    $logDirectory = Join-Path $DataDirectory "logs"
    foreach ($service in $services) {
        $logFile = Join-Path $logDirectory "$($service.Id).log"
        $exists = Test-Path $logFile
        if (-not $exists) {
            Add-Result "Logs" "$($service.Name) wrote a log file" $false $logFile
            continue
        }
        Add-Result "Logs" "$($service.Name) wrote a log file" $true "$([math]::Round((Get-Item $logFile).Length / 1KB, 1)) KB"

        # Only the required services are asserted clean: the capture service legitimately logs a
        # driver error on a machine with no Deltacast board.
        if ($service.Required) {
            $noisy = Select-String -LiteralPath $logFile -Pattern "Error:|Unhandled|EADDRINUSE|Cannot find module|ENOENT|SQLITE_CANTOPEN" -ErrorAction SilentlyContinue
            $detail = if ($noisy) { ($noisy | Select-Object -First 3 | ForEach-Object { $_.Line.Trim() }) -join " | " } else { "no errors logged" }
            Add-Result "Logs" "$($service.Name) log is free of errors" (-not $noisy) $detail
        }
    }

    # A .NET host reads appsettings.json from its content root, and the content root defaults to the
    # working directory - which for this service is a writable folder elsewhere. Without the
    # explicit --contentRoot argument the service starts perfectly happily on its built-in defaults
    # and captures the wrong channel at the wrong frame rate, which is only visible in this line.
    $captureLog = Join-Path $logDirectory "deltacast-capture.log"
    if (Test-Path $captureLog) {
        $contentRoot = Select-String -LiteralPath $captureLog -Pattern "Content root path: (.+)$" |
            Select-Object -First 1
        $rootValue = if ($contentRoot) { $contentRoot.Matches[0].Groups[1].Value.Trim() } else { "" }
        $expected = Join-Path $AppRoot "DeltacastCaptureService"
        Add-Result "Configuration" "Capture service reads appsettings.json from the install folder" `
            ($rootValue -and ($rootValue.TrimEnd('\') -ieq $expected.TrimEnd('\'))) "content root: $rootValue"
    }

    # -----------------------------------------------------------------------------------------
    Write-Step "Desktop applications"
    # -----------------------------------------------------------------------------------------
    # Each UI must open as a native window, not a browser tab. A window whose title has picked up
    # the hosted document's own title ("Emerald Capture - Emerald Streaming") proves three things at
    # once: the window opened, WebView2 initialised, and the page actually loaded.
    $apps = @(
        @{ Id = "emerald";  Title = "Emerald Capture"; DocumentTitle = "Emerald Streaming"; Icon = "emerald-capture.ico" },
        @{ Id = "liveedit"; Title = "LiveEdit";        DocumentTitle = "Emerald Live Edit"; Icon = "liveedit.ico" }
    )

    foreach ($app in $apps) {
        Add-Result "Desktop apps" "$($app.Title) has its own icon" `
            (Test-Path (Join-Path $AppRoot "Launcher\$($app.Icon)")) $app.Icon
    }

    # Snapshot first: the tester's own browser is very likely already open, and counting every
    # browser process would fail this check for a reason that has nothing to do with the product.
    $browsersBefore = @(Get-Process -Name "msedge", "chrome", "firefox" -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Id)

    $appProcesses = @()
    foreach ($app in $apps) {
        $process = Start-Process -FilePath $launcherExe -ArgumentList "--app", $app.Id -PassThru
        $appProcesses += $process

        $loaded = $false
        $windowTitle = ""
        $deadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 1000
            $process.Refresh()
            if ($process.HasExited) { break }
            $windowTitle = $process.MainWindowTitle
            if ($windowTitle -like "*$($app.DocumentTitle)*") { $loaded = $true; break }
        }

        Add-Result "Desktop apps" "$($app.Title) opens a native window" `
            ($windowTitle -like "$($app.Title)*") "window title: '$windowTitle'"
        Add-Result "Desktop apps" "$($app.Title) loads its UI in the window" $loaded `
            $(if ($loaded) { "document title '$($app.DocumentTitle)' reached the window title" } else { "window title never showed the page title" })
    }

    # A WebView2 host process per window is what distinguishes an embedded window from a shelled-out
    # browser - if the UI had opened in Edge or Chrome instead, there would be none.
    $webViewHosts = Get-Process -Name "msedgewebview2" -ErrorAction SilentlyContinue
    Add-Result "Desktop apps" "Windows are WebView2-hosted, not a browser" ($webViewHosts.Count -gt 0) `
        "$($webViewHosts.Count) msedgewebview2 host process(es)"

    $newBrowsers = @(Get-Process -Name "msedge", "chrome", "firefox" -ErrorAction SilentlyContinue |
        Where-Object { $browsersBefore -notcontains $_.Id })
    Add-Result "Desktop apps" "No browser was launched for the UIs" ($newBrowsers.Count -eq 0) `
        $(if ($newBrowsers) { "started: $(($newBrowsers | Select-Object -ExpandProperty ProcessName -Unique) -join ', ')" } else { "no browser process started by opening the apps" })

    # Re-running an app shortcut must raise the open window, not start a second copy fighting over
    # the same WebView2 profile folder.
    $duplicate = Start-Process -FilePath $launcherExe -ArgumentList "--app", "emerald" -PassThru
    Start-Sleep -Seconds 6
    $duplicate.Refresh()
    Add-Result "Desktop apps" "Re-launching an app raises the existing window" $duplicate.HasExited `
        $(if ($duplicate.HasExited) { "second instance exited instead of opening a duplicate" } else { "a second window stayed open" })
    if (-not $duplicate.HasExited) { Stop-Process -Id $duplicate.Id -Force -ErrorAction SilentlyContinue }

    foreach ($process in $appProcesses) {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Seconds 3

    # -----------------------------------------------------------------------------------------
    Write-Step "Process tree"
    # -----------------------------------------------------------------------------------------
    $childNames = @("node", "mediamtx", "ffmpeg", "DeltacastCaptureService")
    $running = Get-Process -Name $childNames -ErrorAction SilentlyContinue
    Add-Result "Processes" "Service processes running under the launcher" ($running.Count -ge 3) "$($running.Count) process(es): $(($running | Select-Object -ExpandProperty ProcessName -Unique) -join ', ')"

    if ($KeepRunning) {
        Write-Step "Leaving the suite running (-KeepRunning)"
    }
    else {
        # -------------------------------------------------------------------------------------
        Write-Step "Shutdown and cleanup"
        # -------------------------------------------------------------------------------------
        # Deliberately a hard kill of the launcher alone. Nothing gets a chance to tidy up, so
        # anything still alive afterwards was only ever held by the job object.
        Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
        $launcher.WaitForExit(20000) | Out-Null
        Start-Sleep -Seconds 5

        $survivors = Get-Process -Name $childNames -ErrorAction SilentlyContinue
        Add-Result "Shutdown" "Job object killed the whole process tree" ($survivors.Count -eq 0) `
            $(if ($survivors) { "survivors: $(($survivors | Select-Object -ExpandProperty ProcessName -Unique) -join ', ')" } else { "no orphaned node/ffmpeg/mediamtx processes" })

        $stillBound = @(5000, 5055, 5173, 5174, 4123, 8554, 8889) | Where-Object { Test-PortListening -Port $_ }
        Add-Result "Shutdown" "All suite ports released" ($stillBound.Count -eq 0) `
            $(if ($stillBound) { "still bound: $($stillBound -join ', ')" } else { "5000, 5055, 5173, 5174, 4123, 8554, 8889 all free" })

        $launcher = $null
    }
}
finally {
    Set-Content -LiteralPath $configPath -Value $originalConfig -Encoding utf8 -NoNewline
    if ($launcher -and -not $KeepRunning) {
        Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------------------------
Write-Step "Summary"
# ---------------------------------------------------------------------------------------------
$passed = ($results | Where-Object Passed).Count
$failed = ($results | Where-Object { -not $_.Passed }).Count
Write-Host ("  {0} passed, {1} failed, {2} total" -f $passed, $failed, $results.Count) -ForegroundColor $(if ($failed) { "Red" } else { "Green" })

$buildInfoPath = Join-Path $AppRoot "build-info.json"
$buildInfo = if (Test-Path $buildInfoPath) { Get-Content $buildInfoPath -Raw | ConvertFrom-Json } else { $null }

$report = [System.Collections.Generic.List[string]]::new()
$report.Add("# Test Report")
$report.Add("")
$report.Add("Produced by ``Installer\build\test-suite.ps1``. It starts the launcher against a built payload,")
$report.Add("exercises every service, port, API and proxy path the product depends on, then kills the launcher")
$report.Add("outright to confirm the process tree dies with it.")
$report.Add("")
$report.Add("| | |")
$report.Add("| --- | --- |")
$report.Add("| Run | $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss K')) |")
$report.Add("| Machine | $env:COMPUTERNAME ($((Get-CimInstance Win32_OperatingSystem).Caption)) |")
$report.Add("| Payload | ``$AppRoot`` |")
if ($buildInfo) {
    $report.Add("| Version | $($buildInfo.version) built $($buildInfo.builtOn) |")
    $report.Add("| Node | $($buildInfo.nodeVersion) (bundled) |")
}
$report.Add("| Result | **$passed passed, $failed failed** |")
$report.Add("")
$report.Add("## Scope")
$report.Add("")
$report.Add("**Covered.** Every service starts and answers its health endpoint; every port binds; the")
$report.Add("Emerald and LiveEdit APIs respond; both frontends serve their built bundles, handle")
$report.Add("single-page-app deep links and proxy their backend paths (including the socket.io")
$report.Add("handshake); Emerald Capture and LiveEdit each open as a native WebView2 window that")
$report.Add("renders its UI, with no browser process involved and no duplicate window on a second")
$report.Add("launch; all runtime data is written outside the install folder; each service logs; and")
$report.Add("a hard kill of the launcher takes the whole process tree, ffmpeg and mediamtx included,")
$report.Add("down with it and releases every port.")
$report.Add("")
$report.Add("**Not covered.** This script exercises the built payload, which is the same tree the")
$report.Add("installer packages, but it does not run the installer executable itself - that needs an")
$report.Add("elevated session. It also does not exercise SDI capture or playout end to end, which")
$report.Add("needs a Deltacast board with an SDI-capable channel and live signal; the capture service is")
$report.Add("verified as far as starting, reading its configuration and serving its control surface.")
$report.Add("")

foreach ($area in ($results | Select-Object -ExpandProperty Area -Unique)) {
    $report.Add("## $area")
    $report.Add("")
    $report.Add("| Result | Check | Detail |")
    $report.Add("| --- | --- | --- |")
    foreach ($result in ($results | Where-Object Area -eq $area)) {
        $mark = if ($result.Passed) { "PASS" } else { "**FAIL**" }
        $detail = $result.Detail -replace '\|', '\|'
        $report.Add("| $mark | $($result.Name) | $detail |")
    }
    $report.Add("")
}

Set-Content -LiteralPath $ReportPath -Value $report -Encoding utf8
Write-Host "  Report written to $ReportPath"

if ($failed -gt 0) { exit 1 }
