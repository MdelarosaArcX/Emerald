# =============================================================================================
#  Emerald Deltacast Suite - installer build
#
#  Compiles all four components, stages them into a single self-contained tree, and hands that
#  tree to Inno Setup to produce Installer\EmeraldDeltacastSuite-Setup-<version>.exe.
#
#  The package deliberately carries its own Node runtime, .NET runtime and FFmpeg build: the
#  target is a broadcast workstation, and "install Node 20, then FFmpeg, then the ASP.NET
#  runtime, and keep all three at the right version" is exactly the kind of prerequisite that
#  goes wrong the week after someone else updates the machine. The only thing the installer
#  cannot supply is the Deltacast/VideoMaster driver, which ships with the SDI board.
#
#  Usage (from anywhere):
#      powershell -ExecutionPolicy Bypass -File Installer\build\build-installer.ps1
#      ... -Version 1.1.0
#      ... -SkipNpmInstall        reuse the staged node_modules from the previous build
#      ... -StageOnly            build the payload tree but do not run Inno Setup
# =============================================================================================

[CmdletBinding()]
param(
    [string]$Version = "1.0.0",

    # Baked into the LiveEdit frontend bundle at build time: the addresses its browser code dials
    # for the Emerald WebRTC preview and monitor. Defaults suit an all-on-one-machine install;
    # override with this machine's LAN IP for a split deployment.
    [string]$EmeraldApiBaseUrl = "http://127.0.0.1:5000",
    [string]$EmeraldMonitorBaseUrl = "http://127.0.0.1:5173",

    [string]$FfmpegBinDir = "C:\ffmpeg\bin",
    [string]$NodeExe = "",
    [string]$IsccPath = "",

    # Both live outside the Emerald repository. Default to sibling folders of the repository; pass
    # these when the workspace is laid out differently.
    [string]$CaptureServicePath = "",
    [string]$MediaMtxPath = "",

    [switch]$SkipNpmInstall,
    [switch]$SkipFrontendBuild,
    [switch]$SkipWebView2Bootstrapper,
    [switch]$StageOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# This script lives in <Emerald repo>\Installer\build, so the Emerald repository is two levels up
# and the workspace containing its sibling components is one further.
#
#   I:\EmeraldDeltacast\            <- workspace root
#   ├── Emerald\                    <- the Emerald repository (this file is inside it)
#   │   ├── backend\  frontend\  LiveEdit\
#   │   └── Installer\build\build-installer.ps1
#   ├── DeltacastCaptureService\    <- separate repository
#   └── MediaMtx\
#
# The capture service and MediaMTX are outside the Emerald repository, so a checkout of Emerald on
# its own is not enough to build the installer. Both locations can be pointed elsewhere with the
# -CaptureServicePath and -MediaMtxPath parameters; both are checked below with a clear message.
$installerRoot = Split-Path -Parent $PSScriptRoot
$emeraldRoot = Split-Path -Parent $installerRoot
$workspaceRoot = Split-Path -Parent $emeraldRoot
$stage = Join-Path $installerRoot "stage"
$liveEditRoot = Join-Path $emeraldRoot "LiveEdit"

if (-not $CaptureServicePath) { $CaptureServicePath = Join-Path $workspaceRoot "DeltacastCaptureService" }
if (-not $MediaMtxPath) { $MediaMtxPath = Join-Path $workspaceRoot "MediaMtx" }
$captureRoot = $CaptureServicePath

function Write-Step { param([string]$Message) Write-Host "`n=== $Message ===" -ForegroundColor Cyan }
function Write-Info { param([string]$Message) Write-Host "    $Message" -ForegroundColor DarkGray }

# Native tools signal failure through the exit code, not through a PowerShell error, so every
# call goes through here — otherwise a failed npm install just leaves a half-empty stage tree and
# the build carries on to produce a broken installer.
function Invoke-Tool {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ToolArgs,
        [string]$WorkingDirectory = $PWD.Path,
        [hashtable]$EnvironmentOverrides = @{}
    )

    $previous = @{}
    foreach ($key in $EnvironmentOverrides.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key)
        [Environment]::SetEnvironmentVariable($key, $EnvironmentOverrides[$key])
    }

    Push-Location $WorkingDirectory
    try {
        & $FilePath @ToolArgs
        if ($LASTEXITCODE -ne 0) {
            throw "$FilePath $($ToolArgs -join ' ') failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
        foreach ($key in $previous.Keys) {
            [Environment]::SetEnvironmentVariable($key, $previous[$key])
        }
    }
}

function Copy-Tree {
    param([string]$Source, [string]$Destination, [string[]]$ExcludeDirectories = @())

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $roboArgs = @($Source, $Destination, "/E", "/NJH", "/NJS", "/NP", "/NDL", "/NFL", "/R:2", "/W:1")
    if ($ExcludeDirectories.Count -gt 0) { $roboArgs += "/XD"; $roboArgs += $ExcludeDirectories }
    & robocopy @roboArgs | Out-Null
    # Robocopy uses exit codes 0-7 for success (bit 0 = files copied, bit 1 = extra files, ...);
    # 8 and above are genuine failures.
    if ($LASTEXITCODE -ge 8) { throw "robocopy '$Source' -> '$Destination' failed with exit code $LASTEXITCODE" }
    $global:LASTEXITCODE = 0
}

function Get-TreeSizeMb {
    param([string]$Path)
    $measured = Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum
    return [math]::Round(($measured.Sum / 1MB), 1)
}

# ---------------------------------------------------------------------------------------------
# 0. Resolve the external tools this build depends on
# ---------------------------------------------------------------------------------------------
Write-Step "Checking build tools"

if (-not $NodeExe) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw "node.exe was not found on PATH. Install Node.js 20+ or pass -NodeExe." }
    $NodeExe = $nodeCommand.Source
}
$nodeVersion = (& $NodeExe --version).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node $nodeVersion is too old; the Emerald backend needs Node 20 or newer." }
Write-Info "node        $nodeVersion ($NodeExe)"

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) { throw "npm.cmd was not found on PATH." }
$npm = $npmCommand.Source
Write-Info "npm         $((& $npm --version).Trim())"

$dotnetCommand = Get-Command dotnet.exe -ErrorAction SilentlyContinue
if (-not $dotnetCommand) { throw "dotnet.exe was not found on PATH. Install the .NET 8 SDK." }
Write-Info "dotnet SDK  $((& dotnet --version).Trim())"

if (-not $StageOnly) {
    if (-not $IsccPath) {
        $candidates = @(
            "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
            "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
            "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
        )
        $IsccPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
    if (-not $IsccPath -or -not (Test-Path $IsccPath)) {
        throw "Inno Setup 6 (ISCC.exe) was not found. Install it (winget install JRSoftware.InnoSetup) or pass -IsccPath."
    }
    Write-Info "Inno Setup  $IsccPath"
}

if (-not (Test-Path (Join-Path $FfmpegBinDir "ffmpeg.exe"))) {
    throw "No ffmpeg.exe under '$FfmpegBinDir'. Point -FfmpegBinDir at a Windows FFmpeg build's bin folder."
}
Write-Info "ffmpeg      $FfmpegBinDir"

# Checked here rather than failing three minutes into the build with a copy error.
if (-not (Test-Path (Join-Path $captureRoot "DeltacastCaptureService.csproj"))) {
    throw "DeltacastCaptureService.csproj was not found under '$captureRoot'. That component lives outside the Emerald repository - clone it beside the repository, or pass -CaptureServicePath."
}
if (-not (Test-Path (Join-Path $MediaMtxPath "mediamtx.exe"))) {
    throw "mediamtx.exe was not found under '$MediaMtxPath'. MediaMTX lives outside the Emerald repository - place it beside the repository, or pass -MediaMtxPath."
}
Write-Info "Emerald     $emeraldRoot"
Write-Info "capture     $captureRoot"
Write-Info "MediaMTX    $MediaMtxPath"

# ---------------------------------------------------------------------------------------------
# 1. Clean the staging tree
# ---------------------------------------------------------------------------------------------
Write-Step "Preparing staging tree"
if (Test-Path $stage) {
    if ($SkipNpmInstall) {
        # Keep only the two staged node_modules trees - the slow part - and clear everything else,
        # including the built frontends, which are re-copied from source below. Named explicitly
        # rather than by a recursive search for "frontend", which would also match folders inside
        # node_modules and quietly delete part of a dependency.
        Get-ChildItem -LiteralPath $stage -Force |
            Where-Object { $_.Name -notin @("Emerald", "LiveEdit") } |
            Remove-Item -Recurse -Force
        foreach ($built in @("Emerald\frontend", "LiveEdit\frontend")) {
            Remove-Item -Recurse -Force (Join-Path $stage $built) -ErrorAction SilentlyContinue
        }
    }
    else {
        Remove-Item -Recurse -Force $stage
    }
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Write-Info $stage

# ---------------------------------------------------------------------------------------------
# 2. Launcher (self-contained WinForms app)
# ---------------------------------------------------------------------------------------------
Write-Step "Building launcher"
& (Join-Path $PSScriptRoot "make-icon.ps1") | ForEach-Object { Write-Info $_ }
Invoke-Tool -FilePath "dotnet" -WorkingDirectory (Join-Path $installerRoot "launcher") -ToolArgs @(
    "publish", "EmeraldLauncher.csproj",
    "-c", "Release",
    "-r", "win-x64",
    "--self-contained", "true",
    "-p:Version=$Version",
    "-o", (Join-Path $stage "Launcher"),
    "-v", "minimal"
)
# The two application windows load their own icons at runtime, so all three ship next to the exe.
foreach ($icon in @("emerald.ico", "emerald-capture.ico", "liveedit.ico")) {
    Copy-Item (Join-Path $installerRoot "launcher\$icon") (Join-Path $stage "Launcher\$icon") -Force
}
Write-Info "Launcher staged ($(Get-TreeSizeMb (Join-Path $stage 'Launcher')) MB)"

# ---------------------------------------------------------------------------------------------
# 3. Deltacast capture service (self-contained ASP.NET Core app)
# ---------------------------------------------------------------------------------------------
Write-Step "Publishing DeltacastCaptureService"
Invoke-Tool -FilePath "dotnet" -WorkingDirectory $captureRoot -ToolArgs @(
    "publish", "DeltacastCaptureService.csproj",
    "-c", "Release",
    "-r", "win-x64",
    "--self-contained", "true",
    "-o", (Join-Path $stage "DeltacastCaptureService"),
    "-v", "minimal"
)
Write-Info "Capture service staged ($(Get-TreeSizeMb (Join-Path $stage 'DeltacastCaptureService')) MB)"

# ---------------------------------------------------------------------------------------------
# 4. Emerald backend (Node) - source plus production-only dependencies
# ---------------------------------------------------------------------------------------------
Write-Step "Staging Emerald backend"
$emeraldBackendStage = Join-Path $stage "Emerald\backend"
New-Item -ItemType Directory -Force -Path $emeraldBackendStage | Out-Null
foreach ($item in @("server.js", "package.json")) {
    Copy-Item (Join-Path $emeraldRoot "backend\$item") $emeraldBackendStage -Force
}
foreach ($directory in @("services", "db", "wwwroot")) {
    Copy-Tree -Source (Join-Path $emeraldRoot "backend\$directory") -Destination (Join-Path $emeraldBackendStage $directory)
}
# The dev tree keeps recorded media under wwwroot\hls; ship the folder, not last week's segments.
Remove-Item -Recurse -Force (Join-Path $emeraldBackendStage "wwwroot\hls") -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $emeraldBackendStage "wwwroot\hls") | Out-Null

if (-not $SkipNpmInstall) {
    Write-Info "npm install --omit=dev (this is the slow step)"
    Invoke-Tool -FilePath $npm -WorkingDirectory $emeraldBackendStage -ToolArgs @("install", "--omit=dev", "--no-audit", "--no-fund")
}
Write-Info "Emerald backend staged ($(Get-TreeSizeMb $emeraldBackendStage) MB)"

# ---------------------------------------------------------------------------------------------
# 5. Emerald frontend (Vite build output only - no Node code ships)
# ---------------------------------------------------------------------------------------------
Write-Step "Building Emerald frontend"
if (-not $SkipFrontendBuild) {
    Invoke-Tool -FilePath $npm -WorkingDirectory (Join-Path $emeraldRoot "frontend") -ToolArgs @("run", "build")
}
Copy-Tree -Source (Join-Path $emeraldRoot "frontend\dist") -Destination (Join-Path $stage "Emerald\frontend")
Write-Info "Emerald frontend staged ($(Get-TreeSizeMb (Join-Path $stage 'Emerald\frontend')) MB)"

# ---------------------------------------------------------------------------------------------
# 6. LiveEdit backend (TypeScript -> dist) plus production-only dependencies
# ---------------------------------------------------------------------------------------------
Write-Step "Building LiveEdit backend"
Invoke-Tool -FilePath $npm -WorkingDirectory (Join-Path $liveEditRoot "backend") -ToolArgs @("run", "build")

$liveEditBackendStage = Join-Path $stage "LiveEdit\backend"
New-Item -ItemType Directory -Force -Path $liveEditBackendStage | Out-Null
Copy-Tree -Source (Join-Path $liveEditRoot "backend\dist") -Destination (Join-Path $liveEditBackendStage "dist")
Copy-Item (Join-Path $liveEditRoot "backend\package.json") $liveEditBackendStage -Force

if (-not $SkipNpmInstall) {
    Invoke-Tool -FilePath $npm -WorkingDirectory $liveEditBackendStage -ToolArgs @("install", "--omit=dev", "--no-audit", "--no-fund")
}
Write-Info "LiveEdit backend staged ($(Get-TreeSizeMb $liveEditBackendStage) MB)"

# ---------------------------------------------------------------------------------------------
# 7. LiveEdit frontend - the two Emerald addresses are compiled into the bundle
# ---------------------------------------------------------------------------------------------
Write-Step "Building LiveEdit frontend"
$liveEditFrontendDir = Join-Path $liveEditRoot "frontend"
if (-not $SkipFrontendBuild) {
    # .env.production.local outranks the checked-in .env, so the developer's LAN addresses in that
    # file cannot leak into a shipped bundle. Removed again below whatever happens.
    $envOverride = Join-Path $liveEditFrontendDir ".env.production.local"
    $envLines = @(
        "# Generated by Installer\build\build-installer.ps1 - safe to delete.",
        "VITE_EMERALD_API_BASE_URL=$EmeraldApiBaseUrl",
        "VITE_EMERALD_MONITOR_BASE_URL=$EmeraldMonitorBaseUrl"
    )
    Set-Content -Path $envOverride -Value $envLines -Encoding utf8
    try {
        Write-Info "VITE_EMERALD_API_BASE_URL=$EmeraldApiBaseUrl"
        Write-Info "VITE_EMERALD_MONITOR_BASE_URL=$EmeraldMonitorBaseUrl"
        Invoke-Tool -FilePath $npm -WorkingDirectory $liveEditFrontendDir -ToolArgs @("run", "build")
    }
    finally {
        Remove-Item -Force $envOverride -ErrorAction SilentlyContinue
    }
}
Copy-Tree -Source (Join-Path $liveEditFrontendDir "dist") -Destination (Join-Path $stage "LiveEdit\frontend")
Write-Info "LiveEdit frontend staged ($(Get-TreeSizeMb (Join-Path $stage 'LiveEdit\frontend')) MB)"

# ---------------------------------------------------------------------------------------------
# 8. Bundled runtimes and media tools
# ---------------------------------------------------------------------------------------------
Write-Step "Staging bundled runtimes"

$nodeStage = Join-Path $stage "Node"
New-Item -ItemType Directory -Force -Path $nodeStage | Out-Null
Copy-Item $NodeExe (Join-Path $nodeStage "node.exe") -Force
$nodeLicense = Join-Path (Split-Path -Parent $NodeExe) "LICENSE"
if (Test-Path $nodeLicense) { Copy-Item $nodeLicense (Join-Path $nodeStage "LICENSE") -Force }
Write-Info "Node runtime staged ($(Get-TreeSizeMb $nodeStage) MB)"

# ffplay is a desktop player nothing in the suite invokes, so it is the one FFmpeg file left out.
$ffmpegStage = Join-Path $stage "ffmpeg\bin"
New-Item -ItemType Directory -Force -Path $ffmpegStage | Out-Null
Get-ChildItem -LiteralPath $FfmpegBinDir -File |
    Where-Object { $_.Name -ne "ffplay.exe" } |
    Copy-Item -Destination $ffmpegStage -Force
Write-Info "FFmpeg staged ($(Get-TreeSizeMb $ffmpegStage) MB)"

# The Edge WebView2 runtime hosts the two application windows. It is a Windows component and is
# present on any up-to-date Windows 10/11 machine, so it is not bundled - but the ~2 MB evergreen
# bootstrapper is, so an installer run on a machine without it can put it there (needs internet at
# install time). Cached between builds; setup.iss simply omits the step if the file is absent.
if (-not $SkipWebView2Bootstrapper) {
    $redistDir = Join-Path $PSScriptRoot "redist"
    New-Item -ItemType Directory -Force -Path $redistDir | Out-Null
    $bootstrapper = Join-Path $redistDir "MicrosoftEdgeWebview2Setup.exe"
    if (-not (Test-Path $bootstrapper)) {
        try {
            Write-Info "Downloading the WebView2 evergreen bootstrapper"
            Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $bootstrapper -UseBasicParsing
        }
        catch {
            Write-Warning "Could not download the WebView2 bootstrapper ($($_.Exception.Message)). The installer will be built without it; target machines will need the WebView2 runtime already present."
        }
    }
    if (Test-Path $bootstrapper) {
        $webViewStage = Join-Path $stage "redist"
        New-Item -ItemType Directory -Force -Path $webViewStage | Out-Null
        Copy-Item $bootstrapper $webViewStage -Force
        Write-Info "WebView2 bootstrapper staged ($(Get-TreeSizeMb $webViewStage) MB)"
    }
}

$mediaMtxStage = Join-Path $stage "MediaMtx"
New-Item -ItemType Directory -Force -Path $mediaMtxStage | Out-Null
Get-ChildItem -LiteralPath $MediaMtxPath -File |
    Where-Object { $_.Extension -notin @(".log") } |
    Copy-Item -Destination $mediaMtxStage -Force
Write-Info "MediaMTX staged ($(Get-TreeSizeMb $mediaMtxStage) MB)"

# ---------------------------------------------------------------------------------------------
# 9. Launcher runtime files, configuration and documentation
# ---------------------------------------------------------------------------------------------
Write-Step "Staging runtime and documentation"
$runtimeStage = Join-Path $stage "runtime"
New-Item -ItemType Directory -Force -Path $runtimeStage | Out-Null
Copy-Item (Join-Path $installerRoot "runtime\static-server.js") $runtimeStage -Force

$configStage = Join-Path $stage "config"
New-Item -ItemType Directory -Force -Path $configStage | Out-Null
Copy-Item (Join-Path $installerRoot "runtime\launcher.config.json") $configStage -Force

Copy-Tree -Source (Join-Path $installerRoot "docs") -Destination (Join-Path $stage "docs")

$manifest = [ordered]@{
    product     = "Emerald Deltacast Suite"
    version     = $Version
    builtOn     = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
    builtBy     = "$env:COMPUTERNAME"
    nodeVersion = $nodeVersion
    components  = @("DeltacastCaptureService", "Emerald backend", "Emerald frontend", "LiveEdit backend", "LiveEdit frontend")
    liveEdit    = [ordered]@{ emeraldApiBaseUrl = $EmeraldApiBaseUrl; emeraldMonitorBaseUrl = $EmeraldMonitorBaseUrl }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $stage "build-info.json") -Encoding utf8

Write-Info "Total payload: $(Get-TreeSizeMb $stage) MB"

# ---------------------------------------------------------------------------------------------
# 10. Compile the installer
# ---------------------------------------------------------------------------------------------
if ($StageOnly) {
    Write-Step "Staging complete (-StageOnly); skipping Inno Setup"
    return
}

Write-Step "Compiling installer"
Invoke-Tool -FilePath $IsccPath -WorkingDirectory $installerRoot -ToolArgs @(
    "/Qp",
    "/DAppVersion=$Version",
    "/DStageDir=$stage",
    "/DOutputDir=$installerRoot",
    (Join-Path $PSScriptRoot "setup.iss")
)

$setupPath = Join-Path $installerRoot "EmeraldDeltacastSuite-Setup-$Version.exe"
if (-not (Test-Path $setupPath)) { throw "Inno Setup reported success but '$setupPath' is missing." }

$setupSizeMb = [math]::Round((Get-Item $setupPath).Length / 1MB, 1)
Write-Host "`nInstaller ready: $setupPath ($setupSizeMb MB)" -ForegroundColor Green
