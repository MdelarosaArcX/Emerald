# Emerald Linux Installer

This installs Emerald Streaming as a Linux `systemd` service.

## Option A: Build A `.run` Installer

From the repository root on Windows:

```powershell
.\deploy\linux\make-run-installer.ps1
```

This creates:

```text
emerald-streaming.run
```

By default this is a self-contained `linux-x64` installer, so the Linux server does not need `dotnet` installed.

For an ARM64 Linux server:

```powershell
.\deploy\linux\make-run-installer.ps1 -Runtime linux-arm64
```

Copy it to Linux:

```powershell
scp .\emerald-streaming.run user@YOUR_SERVER:/tmp/emerald-streaming.run
```

Run it on Linux:

```bash
ssh user@YOUR_SERVER
cd /tmp
chmod +x emerald-streaming.run
sudo ./emerald-streaming.run --install-packages --with-nginx
```

For a domain:

```bash
sudo ./emerald-streaming.run --install-packages --with-nginx --domain recorder.example.com
```

This option includes the published app inside the `.run` file.

The installer replaces the app files while preserving `/opt/emerald-streaming/Recordings` and runtime HLS preview files. Re-run with `--install-packages` when you want it to install `nginx`, `ffmpeg`, and `rsync` through `apt`.

## Option B: Publish And Install Separately

## 1. Publish On Your Dev Machine

From the project folder:

```powershell
cd "C:\Users\asus tuf a15\Documents\Project\Work\ArcX\Project\Emerald\Emerald.Streaming"
dotnet publish -c Release -o publish
```

Copy the published app and installer files to the server:

```powershell
scp -r publish user@YOUR_SERVER:/tmp/emerald-publish
scp -r ..\deploy\linux user@YOUR_SERVER:/tmp/emerald-installer
```

## 2. Install On Linux

SSH to the server:

```bash
ssh user@YOUR_SERVER
cd /tmp/emerald-installer
chmod +x install-emerald.sh
sudo ./install-emerald.sh --source /tmp/emerald-publish --install-packages --with-nginx
```

For a real domain:

```bash
sudo ./install-emerald.sh --source /tmp/emerald-publish --install-packages --with-nginx --domain recorder.example.com
```

## 3. Check The Service

```bash
sudo systemctl status emerald
sudo journalctl -u emerald -f
```

The app runs locally on:

```text
http://127.0.0.1:5000
```

With Nginx enabled, open:

```text
http://YOUR_SERVER_IP
```

## 4. OBS URL Reminder

If OBS is on another machine, do not use `127.0.0.1` for the stream URL.

Use the Linux server IP or hostname:

```text
rtmp://YOUR_SERVER_IP/live/emerald
```

Recordings are saved on Linux at:

```text
/opt/emerald-streaming/Recordings
```
