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

The package includes the Node app and production npm dependencies. The target machine needs Node.js 20+ and FFmpeg installed.

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

In OBS, use:

```text
Server: rtmp://127.0.0.1:1935/live
Stream Key: emerald
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
