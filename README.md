# Emerald

Emerald Streaming is a Node.js/Express OBS recorder with the same browser UI and FFmpeg-backed recording workflow as the original app.

## Run Locally

```powershell
cd Emerald.Streaming
npm install
npm start
```

Open `http://127.0.0.1:5000`.

## OBS Setup

In OBS, set stream service to custom:

```text
Server: rtmp://127.0.0.1:1935/live
Stream Key: emerald
```

Then start streaming in OBS before clicking `Start OBS Preview + Recording` in Emerald.
