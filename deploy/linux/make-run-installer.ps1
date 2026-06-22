param(
    [string]$ProjectPath = "Emerald.Streaming",
    [string]$OutputPath = "emerald-streaming.run",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$project = Resolve-Path (Join-Path $root $ProjectPath)
$staging = Join-Path $root "artifacts\linux-run"
$publish = Join-Path $staging "publish"
$installer = Join-Path $staging "installer"
$payload = Join-Path $staging "payload.tar.gz"
$output = Join-Path $root $OutputPath

Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $publish, $installer | Out-Null

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

Copy-Item (Join-Path $PSScriptRoot "install-emerald.sh") $installer
Copy-Item (Join-Path $PSScriptRoot "emerald.env") $installer
Copy-Item (Join-Path $PSScriptRoot "emerald.service") $installer
Copy-Item (Join-Path $PSScriptRoot "README.md") $installer

tar -czf $payload -C $staging publish installer

$stub = @'
#!/usr/bin/env bash
set -euo pipefail

MARKER="__EMERALD_PAYLOAD_BELOW__"
TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TEMP_DIR}"
}
trap cleanup EXIT

SCRIPT_PATH="$0"
LINE_NUMBER="$(awk "/^${MARKER}$/ { print NR + 1; exit 0; }" "${SCRIPT_PATH}")"

if [[ -z "${LINE_NUMBER}" ]]; then
  echo "Installer payload marker was not found." >&2
  exit 1
fi

tail -n +"${LINE_NUMBER}" "${SCRIPT_PATH}" | tar -xzf - -C "${TEMP_DIR}"

cd "${TEMP_DIR}/installer"
chmod +x install-emerald.sh
exec ./install-emerald.sh --source "${TEMP_DIR}/publish" "$@"

__EMERALD_PAYLOAD_BELOW__
'@

$stub = $stub -replace "`r`n", "`n"
if (-not $stub.EndsWith("`n")) {
    $stub += "`n"
}

[System.IO.File]::WriteAllBytes($output, [System.Text.Encoding]::ASCII.GetBytes($stub))
$payloadBytes = [System.IO.File]::ReadAllBytes($payload)
$outputStream = [System.IO.File]::Open($output, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write)
try {
    $outputStream.Write($payloadBytes, 0, $payloadBytes.Length)
}
finally {
    $outputStream.Dispose()
}

Write-Host "Created $output"
Write-Host "Copy it to Linux, then run:"
Write-Host "  chmod +x $(Split-Path $output -Leaf)"
Write-Host "  sudo ./$(Split-Path $output -Leaf) --install-packages --with-nginx"
