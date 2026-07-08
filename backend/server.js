const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
require("dotenv").config();

const fastify = require("fastify");
const cors = require("@fastify/cors");
const formbody = require("@fastify/formbody");
const multipart = require("@fastify/multipart");
const fastifyStatic = require("@fastify/static");

const { normalizeFfmpegPath } = require("./services/obsRecordingService");
const { ObsIngestService, TX_LIVE_PLAYLIST_NAME, startOrphanTxPlaylistWatcher } = require("./services/obsIngestService");
const { RtmpIngestService } = require("./services/rtmpIngestService");
const { RtmpOutService } = require("./services/rtmpOutService");
const { WebrtcPreviewService } = require("./services/webrtcPreviewService");
const { probeObsStream } = require("./services/obsStreamProbeService");
const { runtimeServices } = require("./services/runtimeServices");
const { DeltacastTxService } = require("./services/deltacastTxService");

const contentRoot = __dirname;
const webRoot = path.join(contentRoot, "wwwroot");
const recordingsPath = process.env.EMERALD_RECORDINGS_PATH
  ? path.resolve(process.env.EMERALD_RECORDINGS_PATH)
  : path.join(contentRoot, "Recordings123");
const thumbnailsPath = path.join(recordingsPath, ".thumbnails");
console.log(`Emerald backend content root: ${recordingsPath}`);
fs.mkdirSync(recordingsPath, { recursive: true });
fs.mkdirSync(thumbnailsPath, { recursive: true });

const app = fastify({
  logger: process.env.EMERALD_LOG_LEVEL
    ? { level: process.env.EMERALD_LOG_LEVEL }
    : false,
  bodyLimit: 2 * 1024 * 1024 * 1024,
});

const obsIngest = new ObsIngestService(recordingsPath);
const rtmpIngest = new RtmpIngestService();
const rtmpOut = new RtmpOutService();
const webrtcPreview = new WebrtcPreviewService();
const deltacastTx = new DeltacastTxService();
rtmpIngest.start();

// Keeps any emerald-tx-live.m3u8 left orphaned by a prior crash/restart in sync with its actual
// .ts segments (or finalized once it's gone idle), so playback/TX can't get stuck waiting forever
// on a stale playlist. See startOrphanTxPlaylistWatcher()'s comment in obsIngestService.js.
startOrphanTxPlaylistWatcher(recordingsPath, (folder) => folder === obsIngest.sessionFolderName && obsIngest.recordingStatus.isRecording);

registerPlugins(app).then(() => registerRoutes(app)).then(start).catch((error) => {
  // Fastify's logger is disabled by default (see the `logger: false` above) unless
  // EMERALD_LOG_LEVEL is set, so app.log.error() alone silently swallows startup failures
  // (e.g. EADDRINUSE from a backend instance already running) — always print to stderr too.
  console.error("Emerald backend failed to start:", error);
  app.log.error(error);
  process.exit(1);
});

async function registerPlugins(server) {
  await server.register(cors, {
    origin: process.env.FRONTEND_ORIGIN || true,
  });
  await server.register(formbody);
  await server.register(multipart, {
    limits: {
      fileSize: 2 * 1024 * 1024 * 1024,
    },
  });
  await server.register(fastifyStatic, {
    root: webRoot,
    prefix: "/",
    decorateReply: false,
  });
  await server.register(fastifyStatic, {
    root: recordingsPath,
    prefix: "/recordings/",
    decorateReply: false,
  });
}

function registerRoutes(server) {
  server.get("/", async () => ({
    name: "Emerald Streaming Backend",
    api: "/api",
    frontend: process.env.FRONTEND_ORIGIN || "http://127.0.0.1:5173",
  }));

  server.get("/api/system/status", async () => ({
    backend: "ok",
    redis: runtimeServices.redisStatus(),
    queues: runtimeServices.queueStatus(),
    postgres: runtimeServices.postgresStatus(),
    rtmpIngest: rtmpIngest.status,
    rtmpOut: rtmpOut.status,
    webrtcPreview: webrtcPreview.status,
  }));

  server.post("/api/system/queue-test", async () => {
    const job = await runtimeServices.enqueue("system.health", {
      createdAt: new Date().toISOString(),
    });

    return {
      id: job.id,
      name: job.name,
      queue: job.queueName,
    };
  });

  server.post("/api/recordings", async (request, reply) => {
    const file = await request.file();

    if (!file) {
      return reply.code(400).send({ message: "Recording file is empty." });
    }

    const buffer = await file.toBuffer();

    if (buffer.length === 0) {
      return reply.code(400).send({ message: "Recording file is empty." });
    }

    const extension = file.mimetype.toLowerCase().includes("mp4") ? ".mp4" : ".webm";
  const fileName = `emerald-preview-${formatUtcTimestamp(new Date())}${extension}`;
  const outputPath = path.join(recordingsPath, fileName);

    await fs.promises.writeFile(outputPath, buffer);

    return {
      fileName,
      url: `/recordings/${fileName}`,
      size: buffer.length,
      contentType: file.mimetype,
    };
  });

  server.get("/api/obs-recording/status", async () => obsIngest.recordingStatus);

  server.get("/api/obs-recordings", async () => {
    const sessionFolders = await listSessionFolders(recordingsPath);
    const recordings = (await Promise.all(sessionFolders.map(async (sessionFolder) => {
      const sessionDir = path.join(recordingsPath, sessionFolder);
      const files = await fs.promises.readdir(sessionDir);

      return Promise.all(files.map(async (fileName) => {
        const filePath = path.join(sessionDir, fileName);
        const stat = await fs.promises.stat(filePath);

        return {
          fileName,
          sessionFolder,
          url: `/recordings/${sessionFolder}/${fileName}`,
          thumbnailUrl: `/api/obs-recordings/${encodeURIComponent(sessionFolder)}/${encodeURIComponent(fileName)}/thumbnail`,
          size: stat.size,
          createdAt: stat.birthtime.toISOString(),
          lastWriteTime: stat.mtimeMs,
        };
      }));
    }))).flat();

    return recordings
      .filter((file) => file.size >= 0 && /\.mp4$/i.test(file.fileName))
      .sort((a, b) => b.lastWriteTime - a.lastWriteTime)
      .slice(0, 100)
      .map(({ lastWriteTime, ...file }) => file);
  });

  server.get("/api/obs-recordings/:folder/:fileName/thumbnail", async (request, reply) => {
    const folder = path.basename(request.params.folder || "");
    const fileName = path.basename(request.params.fileName || "");
    const recordingPath = path.join(recordingsPath, folder, fileName);

    if (!fileName || !folder || !isInsideDirectory(recordingsPath, recordingPath) || !fs.existsSync(recordingPath)) {
      return reply.code(404).send({ message: "Recording was not found." });
    }

    const thumbnailPath = path.join(thumbnailsPath, `${Buffer.from(`${folder}/${fileName}`).toString("base64url")}.jpg`);

    if (!fs.existsSync(thumbnailPath)) {
      await createRecordingThumbnail(recordingPath, thumbnailPath, process.env.FFMPEG_PATH);
    }

    return reply
      .type("image/jpeg")
      .header("Cache-Control", "public, max-age=86400")
      .send(fs.createReadStream(thumbnailPath));
  });

  server.get("/api/recording-sessions", async () => {
    const sessionFolders = await listSessionFolders(recordingsPath);

    const sessions = await Promise.all(sessionFolders.map(async (folder) => {
      const sessionDir = path.join(recordingsPath, folder);
      const [stat, files] = await Promise.all([
        fs.promises.stat(sessionDir),
        fs.promises.readdir(sessionDir),
      ]);
      const segmentFiles = files.filter((fileName) => /\.mp4$/i.test(fileName));
      const sizes = await Promise.all(files.map(async (fileName) => (await fs.promises.stat(path.join(sessionDir, fileName))).size));

      return {
        folder,
        createdAt: stat.birthtime.toISOString(),
        segmentCount: segmentFiles.length,
        size: sizes.reduce((sum, size) => sum + size, 0),
        isActive: folder === obsIngest.sessionFolderName && obsIngest.recordingStatus.isRecording,
      };
    }));

    return sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  });

  server.get("/api/recording-sessions/:folder/segments", async (request, reply) => {
    const folder = path.basename(request.params.folder || "");
    const sessionDir = path.join(recordingsPath, folder);

    if (!folder || !isInsideDirectory(recordingsPath, sessionDir) || !fs.existsSync(sessionDir)) {
      return reply.code(404).send({ message: "Recording session was not found." });
    }

    const files = await fs.promises.readdir(sessionDir);
    const pattern = /^emerald-(\d+)\.mp4$/i;
    const segments = await Promise.all(files
      .map((fileName) => {
        const match = pattern.exec(fileName);
        return match ? { fileName, index: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .map(async ({ fileName, index }) => {
        const stat = await fs.promises.stat(path.join(sessionDir, fileName));

        return {
          fileName,
          index,
          url: `/recordings/${folder}/${fileName}`,
          thumbnailUrl: `/api/obs-recordings/${encodeURIComponent(folder)}/${encodeURIComponent(fileName)}/thumbnail`,
          size: stat.size,
          createdAt: stat.birthtime.toISOString(),
        };
      }));

    return segments
      .sort((a, b) => a.index - b.index)
      .map(({ index, ...segment }) => segment);
  });

  server.post("/api/obs-recording/start", async (request, reply) => {
    const localInputError = rtmpIngest.getLocalInputError(request.body?.inputUrl);
    if (localInputError) {
      return reply.code(400).send({ message: localInputError });
    }

    const { recordingStatus } = await obsIngest.start(request.body || {});
    return recordingStatus;
  });

  server.post("/api/obs-recording/stop", async () => obsIngest.stop().recordingStatus);

  server.get("/api/rtmp-ingest/status", async () => rtmpIngest.status);

  server.get("/api/webrtc-preview/status", async () => webrtcPreview.status);

  server.post("/api/webrtc-preview/start", async (request, reply) => {
    const localInputError = rtmpIngest.getLocalInputError(request.body?.inputUrl);
    if (localInputError) {
      return reply.code(400).send({ message: localInputError });
    }

    try {
      return await webrtcPreview.start(request.body || {});
    } catch (error) {
      return reply.code(400).send({ message: error.message });
    }
  });

  server.post("/api/webrtc-preview/stop", async () => webrtcPreview.stop());

  server.post("/api/obs-stream/probe", async (request) => probeObsStream(request.body || {}));

  server.get("/api/rtmp-out/status", async () => rtmpOut.status);

  server.post("/api/rtmp-out/start", async (request, reply) => {
    const localInputError = rtmpIngest.getLocalInputError(request.body?.inputUrl);
    if (localInputError) {
      return reply.code(400).send({ message: localInputError });
    }

    try {
      return await rtmpOut.start(request.body || {});
    } catch (error) {
      return reply.code(400).send({ message: error.message });
    }
  });

  server.post("/api/rtmp-out/stop", async () => rtmpOut.stop());

  server.get("/api/tx/status", async (_request, reply) => {
    try {
      return await deltacastTx.status();
    } catch (error) {
      return reply.code(502).send({ message: error.message });
    }
  });

  server.post("/api/tx/start", async (request, reply) => {
    const folder = path.basename(String(request.body?.folder || ""));
    const sessionDir = path.join(recordingsPath, folder);

    if (!folder) {
      return reply.code(400).send({ message: "Select a recording folder in Playback before pushing on air." });
    }

    if (!isInsideDirectory(recordingsPath, sessionDir) || !fs.existsSync(sessionDir)) {
      return reply.code(404).send({ message: "Recording session was not found." });
    }

    const requestedFileName = request.body?.fileName ? path.basename(String(request.body.fileName)) : null;

    if (requestedFileName) {
      // Operator staged a single clip in Playback ("Put on Air") — push exactly that file,
      // decoded once and stopped, instead of the whole-folder behaviors below.
      if (!/^emerald-\d+\.mp4$/i.test(requestedFileName)) {
        return reply.code(400).send({ message: "Invalid clip file name." });
      }

      const filePath = path.join(sessionDir, requestedFileName);
      if (!isInsideDirectory(recordingsPath, filePath) || !fs.existsSync(filePath)) {
        return reply.code(404).send({ message: `Clip '${requestedFileName}' was not found in '${folder}'.` });
      }

      try {
        return await deltacastTx.start(filePath, { live: false, loop: false });
      } catch (error) {
        return reply.code(502).send({ message: error.message });
      }
    }

    // A folder that's still being recorded into is followed live via the HLS rendition
    // (emerald-tx-NNN.ts segments, written by obsIngestService alongside the archival mov/mp4
    // outputs) through a playlist Node maintains itself — emerald-tx-live.m3u8, rewritten on
    // every maintenance tick from whatever segments exist on disk. Ffmpeg's own hls muxer also
    // writes a playlist (emerald-tx.m3u8) but its rename-based update gets stuck on Windows once
    // a reader has it open, so that one is ignored. Ffmpeg's "hls" demuxer follows the
    // Node-maintained playlist directly — finished segments play in order, and it naturally
    // waits at the live edge for the next one — instead of looping a one-time snapshot the way
    // a finished session is played back below.
    const isLive = folder === obsIngest.sessionFolderName && obsIngest.recordingStatus.isRecording;

    if (isLive) {
      const txPlaylistPath = path.join(sessionDir, TX_LIVE_PLAYLIST_NAME);

      if (!fs.existsSync(txPlaylistPath)) {
        return reply.code(400).send({ message: "TX playlist isn't ready yet — wait for the first segment to finish and try again." });
      }

      try {
        return await deltacastTx.start(txPlaylistPath, { live: true });
      } catch (error) {
        return reply.code(502).send({ message: error.message });
      }
    }

    const files = await fs.promises.readdir(sessionDir);
    const pattern = /^emerald-(\d+)\.mp4$/i;
    const segments = files
      .map((fileName) => {
        const match = pattern.exec(fileName);
        return match ? { fileName, index: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);

    if (!segments.length) {
      return reply.code(400).send({ message: `No playable segments found in '${folder}'.` });
    }

    const playlistPath = path.join(os.tmpdir(), "emerald-tx-playlist.txt");
    const playlistContent = segments
      .map((segment) => `file '${path.join(sessionDir, segment.fileName).replace(/\\/g, "/")}'`)
      .join("\n");
    await fs.promises.writeFile(playlistPath, playlistContent, "utf8");

    try {
      return await deltacastTx.start(playlistPath);
    } catch (error) {
      return reply.code(502).send({ message: error.message });
    }
  });

  server.post("/api/tx/stop", async (_request, reply) => {
    try {
      return await deltacastTx.stop();
    } catch (error) {
      return reply.code(502).send({ message: error.message });
    }
  });

  server.setErrorHandler((error, _request, reply) => {
    reply.code(error.statusCode || error.status || 400).send({
      message: error.message || "Unexpected server error.",
    });
  });
}

const { host, port } = resolveListenTarget(process.argv, process.env);
async function start() {
  await app.listen({ host, port });
  console.log(`Emerald Streaming backend listening on http://${host}:${port}`);
}

const shutdown = () => {
  obsIngest.stop();
  rtmpIngest.stop();
  rtmpOut.stop();
  webrtcPreview.stopAll();
  runtimeServices.close()
    .finally(() => app.close())
    .finally(() => process.exit(0));
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

async function listSessionFolders(rootDirectory) {
  const entries = await fs.promises.readdir(rootDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

function isInsideDirectory(rootDirectory, targetPath) {
  const relative = path.relative(rootDirectory, targetPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function createRecordingThumbnail(inputPath, outputPath, configuredFfmpegPath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ffmpegPath = normalizeFfmpegPath(configuredFfmpegPath);
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-ss", "00:00:01",
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", "scale=320:-1:force_original_aspect_ratio=decrease",
      outputPath,
    ];
    const ffmpeg = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let lastMessage = "";
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fs.rm(outputPath, { force: true }, () => {});
      reject(error);
    };
    const timeout = setTimeout(() => {
      if (!ffmpeg.killed) {
        ffmpeg.kill("SIGKILL");
      }
      fail(new Error("Thumbnail generation timed out."));
    }, 8000);

    ffmpeg.stderr.on("data", (chunk) => {
      lastMessage = chunk.toString().trim() || lastMessage;
    });

    ffmpeg.on("error", (error) => {
      fail(error);
    });

    ffmpeg.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
        return;
      }

      reject(new Error(lastMessage || "Unable to create recording thumbnail."));
    });
  });
}
