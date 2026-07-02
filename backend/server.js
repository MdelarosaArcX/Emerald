const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
require("dotenv").config();

const fastify = require("fastify");
const cors = require("@fastify/cors");
const formbody = require("@fastify/formbody");
const multipart = require("@fastify/multipart");
const fastifyStatic = require("@fastify/static");

const { normalizeFfmpegPath } = require("./services/obsRecordingService");
const { ObsIngestService } = require("./services/obsIngestService");
const { RtmpIngestService } = require("./services/rtmpIngestService");
const { WebrtcPreviewService } = require("./services/webrtcPreviewService");
const { probeObsStream } = require("./services/obsStreamProbeService");
const { runtimeServices } = require("./services/runtimeServices");

const contentRoot = __dirname;
const webRoot = path.join(contentRoot, "wwwroot");
const recordingsPath = path.join(contentRoot, "Recordings");
const thumbnailsPath = path.join(recordingsPath, ".thumbnails");

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
const webrtcPreview = new WebrtcPreviewService();
rtmpIngest.start();

registerPlugins(app).then(() => registerRoutes(app)).then(start).catch((error) => {
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
    const files = await fs.promises.readdir(recordingsPath);
    const recordings = await Promise.all(files.map(async (fileName) => {
      const filePath = path.join(recordingsPath, fileName);
      const stat = await fs.promises.stat(filePath);

      return {
        fileName,
        url: `/recordings/${fileName}`,
        thumbnailUrl: `/api/obs-recordings/${encodeURIComponent(fileName)}/thumbnail`,
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
        lastWriteTime: stat.mtimeMs,
      };
    }));

    return recordings
      .filter((file) => file.size >= 0 && !file.fileName.startsWith(".") && !/\.mov$/i.test(file.fileName))
      .sort((a, b) => b.lastWriteTime - a.lastWriteTime)
      .slice(0, 100)
      .map(({ lastWriteTime, ...file }) => file);
  });

  server.get("/api/obs-recordings/:fileName/thumbnail", async (request, reply) => {
    const fileName = path.basename(request.params.fileName || "");
    const recordingPath = path.join(recordingsPath, fileName);

    if (!fileName || !isInsideDirectory(recordingsPath, recordingPath) || !fs.existsSync(recordingPath)) {
      return reply.code(404).send({ message: "Recording was not found." });
    }

    const thumbnailPath = path.join(thumbnailsPath, `${Buffer.from(fileName).toString("base64url")}.jpg`);

    if (!fs.existsSync(thumbnailPath)) {
      await createRecordingThumbnail(recordingPath, thumbnailPath, process.env.FFMPEG_PATH);
    }

    return reply
      .type("image/jpeg")
      .header("Cache-Control", "public, max-age=86400")
      .send(fs.createReadStream(thumbnailPath));
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
