param(
    [string]$Source = (Join-Path $PSScriptRoot "publish"),
    [string]$InstallDir = (Join-Path $env:ProgramFiles "Emerald Streaming"),
    [string]$TaskName = "EmeraldStreaming",
    [string]$Urls = "http://127.0.0.1:5000",
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)

    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this installer from an elevated PowerShell window."
    }
}

Assert-Administrator

$recordingsDir = Join-Path $InstallDir "Recordings"
$hlsDir = Join-Path $InstallDir "wwwroot\hls\obs-preview"

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    Write-Host "Removed scheduled task '$TaskName'. App files were left at '$InstallDir'."
    exit 0
}

if (-not (Test-Path $Source)) {
    throw "Source folder was not found: $Source"
}

$serverPath = Join-Path $Source "server.js"
$packagePath = Join-Path $Source "package.json"

if (-not (Test-Path $serverPath) -or -not (Test-Path $packagePath)) {
    throw "server.js and package.json were not found in '$Source'. Run the package builder first."
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $InstallDir, $recordingsDir, $hlsDir | Out-Null

Get-ChildItem -LiteralPath $InstallDir -Force |
    Where-Object {
        $_.FullName -ne $recordingsDir -and
        $_.FullName -ne (Join-Path $InstallDir "wwwroot")
    } |
    Remove-Item -Recurse -Force

$wwwrootDir = Join-Path $InstallDir "wwwroot"
if (Test-Path $wwwrootDir) {
    Get-ChildItem -LiteralPath $wwwrootDir -Force |
        Where-Object { $_.FullName -ne (Join-Path $wwwrootDir "hls") } |
        Remove-Item -Recurse -Force
}

Copy-Item -Path (Join-Path $Source "*") -Destination $InstallDir -Recurse -Force
New-Item -ItemType Directory -Force -Path $recordingsDir, $hlsDir | Out-Null

$installedServer = Join-Path $InstallDir "server.js"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { $null }
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
}
$npm = if ($npmCommand) { $npmCommand.Source } else { $null }

if (-not $node) {
    throw "node was not found. Install Node.js 20 or newer before installing Emerald Streaming."
}

if (-not $npm -and -not (Test-Path (Join-Path $InstallDir "node_modules"))) {
    throw "npm was not found and node_modules is not included. Install npm or rebuild the package with dependencies."
}

if ($npm -and -not (Test-Path (Join-Path $InstallDir "node_modules"))) {
    Push-Location $InstallDir
    try {
        & $npm install --omit=dev
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

$execute = $node
$arguments = "`"$installedServer`" --urls `"$Urls`""
$action = New-ScheduledTaskAction -Execute $execute -Argument $arguments -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "Emerald Streaming is installed."
Write-Host "Task name: $TaskName"
Write-Host "Install directory: $InstallDir"
Write-Host "Recordings directory: $recordingsDir"
Write-Host "Local app URL: $Urls"
