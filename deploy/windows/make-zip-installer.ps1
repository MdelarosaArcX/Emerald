param(
    [string]$ProjectPath = "Emerald.Streaming",
    [string]$OutputPath = "emerald-streaming-windows.zip",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$project = Resolve-Path (Join-Path $root $ProjectPath)
$staging = Join-Path $root "artifacts\windows-installer"
$publish = Join-Path $staging "publish"
$output = Join-Path $root $OutputPath

Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $publish | Out-Null

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [Parameter(Mandatory = $true)]
        [string[]]$CommandArguments
    )

    & $Command @CommandArguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

$exclude = @("node_modules", "Recordings", "bin", "obj", "Pages", "Properties")
Get-ChildItem -LiteralPath $project -Force |
    Where-Object { $exclude -notcontains $_.Name } |
    Copy-Item -Destination $publish -Recurse -Force

Remove-Item -Recurse -Force (Join-Path $publish "wwwroot\hls") -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $publish "wwwroot\hls") | Out-Null

if (-not $SkipInstall) {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $npm = if ($npmCommand) { $npmCommand.Source } else { "npm" }
    Push-Location $publish
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

Copy-Item (Join-Path $PSScriptRoot "install-emerald-windows.ps1") $staging
Copy-Item (Join-Path $PSScriptRoot "README.md") $staging

if (Test-Path $output) {
    Remove-Item -Force $output
}

Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $output -Force

Write-Host "Created $output"
Write-Host "Extract it on Windows, then run PowerShell as Administrator:"
Write-Host "  Set-ExecutionPolicy -Scope Process Bypass"
Write-Host "  .\install-emerald-windows.ps1"
