param(
    [string]$ProjectPath = "Emerald.Streaming",
    [string]$OutputPath = "emerald-streaming-windows.zip",
    [string]$Configuration = "Release",
    [string]$Runtime = "win-x64",
    [switch]$FrameworkDependent
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
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE"
    }
}

if ($FrameworkDependent) {
    Invoke-CheckedCommand dotnet @("publish", $project, "-c", $Configuration, "-o", $publish)
}
else {
    Invoke-CheckedCommand dotnet @("publish", $project, "-c", $Configuration, "-r", $Runtime, "--self-contained", "true", "-o", $publish)
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
