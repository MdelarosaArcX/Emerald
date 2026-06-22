param(
    [string]$ProjectPath = "Emerald.Streaming",
    [string]$OutputPath = "emerald-streaming.run",
    [string]$Configuration = "Release",
    [string]$Runtime = "linux-x64",
    [switch]$FrameworkDependent
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
