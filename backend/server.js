const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config();

const fastify = require("fastify");
const cors = require("@fastify/cors");
const formbody = require("@fastify/formbody");
const multipart = require("@fastify/multipart");
const fastifyStatic = require("@fastify/static");

const { ObsRecordingService } = require("./services/obsRecordingService");
const { ObsPreviewService } = require("./services/obsPreviewService");
const { RtmpIngestService } = require("./services/rtmpIngestService");
const { probeObsStream } = require("./services/obsStreamProbeService");
const { runtimeServices } = require("./services/runtimeServices");

const contentRoot = __dirname;
const webRoot = path.join(contentRoot, "wwwroot");
const recordingsPath = path.join(contentRoot, "Recordings");

fs.mkdirSync(recordingsPath, { recursive: true });

const app = fastify({
  logger: process.env.EMERALD_LOG_LEVEL
    ? { level: process.env.EMERALD_LOG_LEVEL }
    : false,
  bodyLimit: 2 * 1024 * 1024 * 1024,
});

const obsRecorder = new ObsRecordingService(recordingsPath);
const obsPreview = new ObsPreviewService(webRoot);
const rtmpIngest = new RtmpIngestService();
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
    setHeaders: (response, filePath) => {
      if (filePath.toLowerCase().endsWith(".m3u8")) {
        response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      }

      if (filePath.toLowerCase().endsWith(".ts")) {
        response.setHeader("Content-Type", "video/mp2t");
      }
    },
  });
  await server.register(fastifyStatic, {
    root: path.join(contentRoot, "node_modules", "hls.js", "dist"),
    prefix: "/lib/hls.js/",
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

  server.get("/api/obs-recording/status", async () => obsRecorder.status);

  server.get("/api/obs-recordings", async () => {
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

    return recordings
      .filter((file) => file.size >= 0)
      .sort((a, b) => b.lastWriteTime - a.lastWriteTime)
      .slice(0, 100)
      .map(({ lastWriteTime, ...file }) => file);
  });

  server.post("/api/obs-recording/start", async (request, reply) => {
    const localInputError = rtmpIngest.getLocalInputError(request.body?.inputUrl);
    if (localInputError) {
      return reply.code(400).send({ message: localInputError });
    }

    return obsRecorder.start(request.body || {});
  });

  server.post("/api/obs-recording/stop", async () => obsRecorder.stop());

  server.get("/api/obs-preview/status", async () => obsPreview.status);

  server.get("/api/rtmp-ingest/status", async () => rtmpIngest.status);

  server.post("/api/obs-preview/start", async (request, reply) => {
    const localInputError = rtmpIngest.getLocalInputError(request.body?.inputUrl);
    if (localInputError) {
      return reply.code(400).send({ message: localInputError });
    }

    return obsPreview.start(request.body || {});
  });

  server.post("/api/obs-preview/stop", async () => obsPreview.stop());

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
  obsRecorder.stop();
  obsPreview.stop();
  rtmpIngest.stop();
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
