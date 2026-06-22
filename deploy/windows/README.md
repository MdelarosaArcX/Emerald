# Emerald Windows Installer

This creates a zip package that installs Emerald Streaming on Windows and starts it on boot with Task Scheduler.

## Build The Installer

From the repository root:

```powershell
.\deploy\windows\make-zip-installer.ps1
```

This creates:

```text
emerald-streaming-windows.zip
```

By default this is a self-contained `win-x64` package, so the target machine does not need `dotnet` installed.

## Install On Windows

Extract `emerald-streaming-windows.zip`, then open PowerShell as Administrator in the extracted folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-emerald-windows.ps1
```

The app is installed to:

```text
C:\Program Files\Emerald Streaming
```

The app listens locally on:

```text
http://127.0.0.1:5000
```

To listen on all network interfaces:

```powershell
.\install-emerald-windows.ps1 -Urls "http://0.0.0.0:5000"
```

Recordings are saved at:

```text
C:\Program Files\Emerald Streaming\Recordings
```

## Manage The Startup Task

```powershell
Get-ScheduledTask -TaskName EmeraldStreaming
Start-ScheduledTask -TaskName EmeraldStreaming
Stop-ScheduledTask -TaskName EmeraldStreaming
```

To remove the startup task while leaving installed files in place:

```powershell
.\install-emerald-windows.ps1 -Uninstall
```
