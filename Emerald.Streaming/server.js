const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");

const { ObsRecordingService } = require("./services/obsRecordingService");
const { ObsPreviewService } = require("./services/obsPreviewService");
const { RtmpIngestService } = require("./services/rtmpIngestService");
const { probeObsStream } = require("./services/obsStreamProbeService");

const contentRoot = __dirname;
const webRoot = path.join(contentRoot, "wwwroot");
const recordingsPath = path.join(contentRoot, "Recordings");

fs.mkdirSync(recordingsPath, { recursive: true });

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024,
  },
});

const obsRecorder = new ObsRecordingService(recordingsPath);
const obsPreview = new ObsPreviewService(webRoot);
const rtmpIngest = new RtmpIngestService();
rtmpIngest.start();

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(webRoot, {
  setHeaders: (response, filePath) => {
    if (filePath.toLowerCase().endsWith(".m3u8")) {
      response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    }

    if (filePath.toLowerCase().endsWith(".ts")) {
      response.setHeader("Content-Type", "video/mp2t");
    }
  },
}));

app.use("/lib/hls.js", express.static(path.join(contentRoot, "node_modules", "hls.js", "dist")));
app.use("/recordings", express.static(recordingsPath));

app.get("/", (_request, response) => {
  response.sendFile(path.join(contentRoot, "index.html"));
});

app.post("/api/recordings", upload.single("file"), async (request, response) => {
  if (!request.file || request.file.size === 0) {
    return response.status(400).json({ message: "Recording file is empty." });
  }

  const extension = request.file.mimetype.toLowerCase().includes("mp4") ? ".mp4" : ".webm";
  const fileName = `emerald-preview-${formatUtcTimestamp(new Date())}${extension}`;
  const outputPath = path.join(recordingsPath, fileName);

  await fs.promises.writeFile(outputPath, request.file.buffer);

  return response.json({
    fileName,
    url: `/recordings/${fileName}`,
    size: request.file.size,
    contentType: request.file.mimetype,
  });
});

app.get("/api/obs-recording/status", (_request, response) => {
  response.json(obsRecorder.status);
});

app.get("/api/obs-recordings", async (_request, response, next) => {
  try {
    const files = await fs.promises.readdir(recordingsPath);
    const recordings = await Promise.all(files.map(async (fileName) => {
      const filePath = path.join(recordingsPath, fileName);
      const stat = await fs.promises.stat(filePath);

      return {
        fileName,
        url: `/recordings/${fileName}`,
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
        lastWriteTime: stat.mtimeMs,
      };
    }));

    response.json(recordings
      .filter((file) => file.size >= 0)
      .sort((a, b) => b.lastWriteTime - a.lastWriteTime)
      .slice(0, 100)
      .map(({ lastWriteTime, ...file }) => file));
  } catch (error) {
    next(error);
  }
});

app.post("/api/obs-recording/start", async (request, response) => {
  try {
    const localInputError = rtmpIngest.getLocalInputError(request.body?.inputUrl);
    if (localInputError) {
      return response.status(400).json({ message: localInputError });
    }

    response.json(await obsRecorder.start(request.body || {}));
  } catch (error) {
    response.status(400).json({ message: error.message });
  }
});

app.post("/api/obs-recording/stop", (_request, response) => {
  response.json(obsRecorder.stop());
});

app.get("/api/obs-preview/status", (_request, response) => {
  response.json(obsPreview.status);
});

app.get("/api/rtmp-ingest/status", (_request, response) => {
  response.json(rtmpIngest.status);
});

app.post("/api/obs-preview/start", async (request, response) => {
  try {
    const localInputError = rtmpIngest.getLocalInputError(request.body?.inputUrl);
    if (localInputError) {
      return response.status(400).json({ message: localInputError });
    }

    response.json(await obsPreview.start(request.body || {}));
  } catch (error) {
    response.status(400).json({ message: error.message });
  }
});

app.post("/api/obs-preview/stop", (_request, response) => {
  response.json(obsPreview.stop());
});

app.post("/api/obs-stream/probe", async (request, response) => {
  try {
    response.json(await probeObsStream(request.body || {}));
  } catch (error) {
    response.status(400).json({ message: error.message });
  }
});

app.use((error, _request, response, _next) => {
  response.status(error.status || 500).json({ message: error.message || "Unexpected server error." });
});

const { host, port } = resolveListenTarget(process.argv, process.env);
const server = app.listen(port, host, () => {
  console.log(`Emerald Streaming listening on http://${host}:${port}`);
});

const shutdown = () => {
  obsRecorder.stop();
  obsPreview.stop();
  rtmpIngest.stop();
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function resolveListenTarget(argv, env) {
  const urlsArgIndex = argv.findIndex((arg) => arg === "--urls");
  const urlValue = urlsArgIndex >= 0 ? argv[urlsArgIndex + 1] : env.EMERALD_URLS || "http://127.0.0.1:5000";
  const firstUrl = String(urlValue).split(";")[0];
  const parsed = new URL(firstUrl);
  const host = parsed.hostname === "0.0.0.0" || parsed.hostname === "::" ? parsed.hostname : parsed.hostname || "127.0.0.1";
  const port = Number(parsed.port || 5000);

  return { host, port };
}

function formatUtcTimestamp(date) {
  const pad = (value, length = 2) => String(value).padStart(length, "0");

  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
    + `-${pad(date.getUTCMilliseconds(), 3)}`;
}
