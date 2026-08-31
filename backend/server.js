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
const { ObsIngestService, TX_LIVE_PLAYLIST_NAME, TX_HLS_SEGMENT_SECONDS, startOrphanTxPlaylistWatcher, resolveBackupDir } = require("./services/obsIngestService");
const { StorageQuotaWatchdog } = require("./services/storageQuotaWatchdog");
const { ClipExportService } = require("./services/clipExportService");
const { EditCaptureService, MASTER_PATTERN: EDIT_CAPTURE_MASTER_PATTERN } = require("./services/editCaptureService");
const { RtmpIngestService } = require("./services/rtmpIngestService");
const { RtmpOutService } = require("./services/rtmpOutService");
const { WebrtcPreviewService, stopSharedMediaMtx } = require("./services/webrtcPreviewService");
const {
  addCut: addAirCut,
  removeCut: removeAirCut,
  addInsert: addAirInsert,
  removeInsert: removeAirInsert,
  describeEdl: describeAirEdl,
  loadEdl: loadAirEdl,
} = require("./services/airEdlService");
const { probeObsStream } = require("./services/obsStreamProbeService");
const { runtimeServices } = require("./services/runtimeServices");
const { DeltacastTxService } = require("./services/deltacastTxService");
const { TimecodeLogService } = require("./services/timecodeLogService");
const { TimecodeMasterService } = require("./services/timecodeMasterService");
const { logEvent, readRecentEvents } = require("./services/eventLogService");
const { probeSegment, mapWithConcurrency } = require("./services/segmentProbeService");

// Ceiling on concurrent ffprobe child processes per segment-listing request. A long session
// folder holds tens of thousands of segments, and fanning out one process per segment starved the
// event loop to the point that the whole HTTP API stopped answering.
const SEGMENT_PROBE_CONCURRENCY = 8;

/**
 * The capture instant the transmission is currently playing, in epoch ms — or null when it can't
 * be derived.
 *
 * Every frame TX has sent is one frame of playlist content consumed, so the position is simply the
 * first listed segment's start plus that many frames. The first segment is read from the
 * playlist's own #EXT-X-MEDIA-SEQUENCE rather than assumed to be 0, because the storage quota's
 * rolling trim deletes the earliest segments on a long recording and the playlist tracks whatever
 * actually survives.
 *
 * Cuts committed to air shorten the playlist, so frames already sent cover more elapsed capture
 * time than their count suggests. Each cut the position has passed is added back — iteratively,
 * since restoring one cut's duration can carry the position over the next.
 */
/**
 * The content instant a transmission opens at, read from the playlist as it stands right now.
 *
 * "beginning" opens on the first segment the playlist still lists — not necessarily segment 0, since
 * the storage quota can trim the earliest ones out from under a long session, which is why the
 * MEDIA-SEQUENCE is read rather than assumed.
 *
 * "delay" is a resume, joining Transmit:HlsStartRunwaySegments back from the newest listed segment.
 * The runway is the capture service's setting and not visible here; three segments is its default
 * and the figure its own documentation quotes, so a resume anchored this way is right to within a
 * segment rather than wrong by the length of the playlist, which is what assuming index 0 gave.
 *
 * Null when the playlist cannot be read, which leaves onAirContentTime on its configured-hold
 * fallback.
 */
function playlistJoinContentMs(sessionDir, startAt, recordingStartedAtMs) {
  if (!Number.isFinite(recordingStartedAtMs)) return null;

  try {
    const playlist = fs.readFileSync(path.join(sessionDir, TX_LIVE_PLAYLIST_NAME), "utf8");
    const match = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/m.exec(playlist);
    if (!match) return null;

    const firstIndex = Number(match[1]);
    const listedSegments = (playlist.match(/^#EXTINF:/gm) || []).length;
    const segmentMs = TX_HLS_SEGMENT_SECONDS * 1000;

    if (startAt === "beginning") return recordingStartedAtMs + firstIndex * segmentMs;

    const HLS_RESUME_RUNWAY_SEGMENTS = 3;
    const joinIndex = Math.max(firstIndex, firstIndex + listedSegments - HLS_RESUME_RUNWAY_SEGMENTS);
    return recordingStartedAtMs + joinIndex * segmentMs;
  } catch {
    return null;
  }
}

function onAirContentTime({ recordingStartedAtMs, sessionDir, segmentSeconds, broadcastDelaySeconds, anchor, nowMs = Date.now() }) {
  if (!Number.isFinite(recordingStartedAtMs)) return null;

  // Where air is, as wall-clock arithmetic rather than a frame count.
  //
  // This used to derive the position from TX's framesSent against the playlist. That reading is
  // only as steady as the counter behind it, and the counter is not steady: a decode restart, a
  // stalled read, or — since clips could be booked into the transmission — frames of inserted
  // material that are not live content at all, all move it out of step with the wall clock. The
  // position was recomputed on every poll, so each of those became a jump, and because the readout
  // ticks forward locally between polls, a jump backwards showed on screen as the timecode
  // stopping and restarting.
  //
  // Air advances at exactly 1x, so once the instant it opened at is known the position needs no
  // measurement at all. `anchor` records that instant when the transmission starts; without one
  // (a backend restarted mid-transmission) the hold TX waited out before opening is the same
  // figure by construction — a session opened at its first completed segment trails capture by
  // exactly one segment plus one broadcast delay, and keeps trailing by it.
  const holdMs = ((segmentSeconds || 0) + (broadcastDelaySeconds || 0)) * 1000;
  const baseMs = anchor
    ? anchor.contentAtMs + (nowMs - anchor.startedAtMs)
    : nowMs - holdMs;

  if (!Number.isFinite(baseMs)) return null;

  // Edits air has already played through move it off that line, in opposite directions: a cut
  // removed content, so air reached what follows sooner; an inserted clip added playlist time that
  // is not content, so air reached what follows later. An overlay does neither — it replaces an
  // equal span, which is why only "insert" counts here.
  //
  // Fixed point, because crediting one edit can carry the position past another.
  let positionMs = baseMs;
  try {
    const { cuts, inserts } = loadAirEdl(sessionDir);
    const added = inserts.filter((entry) => entry.mode === "insert");

    for (let pass = 0; pass < 8; pass += 1) {
      const cutMs = cuts
        .filter((cut) => cut.startMs < positionMs)
        .reduce((sum, cut) => sum + Math.min(cut.endMs - cut.startMs, Math.max(0, positionMs - cut.startMs)), 0);
      const insertMs = added
        .filter((entry) => entry.atMs < positionMs)
        .reduce((sum, entry) => sum + Math.min(entry.durationMs, Math.max(0, positionMs - entry.atMs)), 0);

      const next = baseMs + cutMs - insertMs;
      if (Math.abs(next - positionMs) < 1) break;
      positionMs = next;
    }
  } catch {
    // No EDL, or an unreadable one — the unedited position is still the right answer.
  }

  return positionMs;
}

const db = require("./db");

const contentRoot = __dirname;
const webRoot = path.join(contentRoot, "wwwroot");
const recordingsPath = process.env.EMERALD_RECORDINGS_PATH
  ? path.resolve(process.env.EMERALD_RECORDINGS_PATH)
  : path.join(contentRoot, "Recordings");
const thumbnailsPath = path.join(recordingsPath, ".thumbnails");
const editCapturePath = process.env.EMERALD_EDIT_CAPTURE_PATH
  ? path.resolve(process.env.EMERALD_EDIT_CAPTURE_PATH)
  : path.join(contentRoot, "EditCaptures");
console.log(`Emerald backend content root: ${recordingsPath}`);
fs.mkdirSync(recordingsPath, { recursive: true });
fs.mkdirSync(thumbnailsPath, { recursive: true });
fs.mkdirSync(editCapturePath, { recursive: true });

const app = fastify({
  logger: process.env.EMERALD_LOG_LEVEL
    ? { level: process.env.EMERALD_LOG_LEVEL }
    : false,
  bodyLimit: 2 * 1024 * 1024 * 1024,
});

const obsIngest = new ObsIngestService(recordingsPath);
const editCapture = new EditCaptureService(editCapturePath);
const rtmpIngest = new RtmpIngestService();
const rtmpOut = new RtmpOutService();
const webrtcPreview = new WebrtcPreviewService();
const deltacastTx = new DeltacastTxService();
// Joins selected Media Browser clips into one timecoded file. Lives beside the recordings rather
// than inside them so exports are never mistaken for capture output by the quota watchdog or the
// segment reconciler.
const exportsPath = process.env.EMERALD_EXPORTS_PATH
  ? path.resolve(process.env.EMERALD_EXPORTS_PATH)
  : path.join(contentRoot, "Exports");
fs.mkdirSync(exportsPath, { recursive: true });
const clipExport = new ClipExportService(recordingsPath, exportsPath);
rtmpIngest.start();

// DeltacastSdkService's RX3 capture loop runs continuously for this whole C# process's lifetime
// (started once at boot by DeltacastCaptureService's Worker — it also feeds the always-on
// preview), completely independent of whether an Emerald recording is running. FramesReceived/
// FramesDropped there are therefore lifetime counters of the signal itself, not scoped to any
// particular recording — this snapshot is subtracted from them so the Capture page's "Video
// Framecount"/"Video Frames Dropped" only count frames captured *during the current recording*,
// resetting to 0 each time recording starts and freezing at 0 (not counting) while stopped.
let sessionFrameBaseline = null;

/**
 * The instant the current transmission opened, and the content instant it opened *at*.
 *
 * Air runs at 1x, so these two together fix its position for the whole transmission without
 * measuring anything — see onAirContentTime. Recorded when TX starts because that is the only
 * moment the join point is known: a session opened for the first time starts at its first listed
 * segment, a resumed one joins near the live edge, and nothing afterwards can tell the two apart.
 *
 * Null when nothing is airing this session's live playlist, including after a backend restart —
 * onAirContentTime falls back to the configured hold, which is the same figure for the common case.
 */
let onAirAnchor = null;

// DeltacastCaptureService's TX decode process publishes its own low-latency WebRTC preview
// directly to MediaMTX via RTSP (see DeltacastTxService.cs's PreviewRelayUrl) — mirroring the
// exact same decoded frames it feeds to the SDI board, so this preview can't drift from the
// source *timeline* the way independently decoding it a second time (e.g. via HLS) could. It
// still runs ahead of the physical TX6 output in wall-clock terms (the SDI path has buffering
// stages this WebRTC path doesn't share) — see SessionPlaybackDeck.vue's operator-tunable
// playoutDelayHint for the compensation. Node doesn't manage an ffmpeg process for this one
// (unlike webrtcPreview above) since TX's own process publishes/unpublishes on its own as it
// starts/stops — this is just the static WHEP URL for it.
const onAirPreviewWhepUrl = `http://${process.env.MEDIAMTX_PUBLIC_HOST || "127.0.0.1"}:${Number(process.env.MEDIAMTX_WHEP_PORT || 8889)}/live/onair/whep`;

/**
 * The same on-air feed, addressed the ways a general-purpose player can open it.
 *
 * WHEP above is a browser protocol — VLC, a hardware decoder or a downstream station cannot use
 * it. MediaMTX already serves the identical `live/onair` path over RTSP, HLS and SRT (all enabled
 * in MediaMtx/mediamtx.yml), so this exposes those addresses rather than publishing anything new:
 * it is the same single publisher, read by a different protocol.
 *
 * Built from MEDIAMTX_PUBLIC_HOST for the same reason the WHEP URL is — these are absolute
 * addresses dialled from another machine on the LAN, so 0.0.0.0 or 127.0.0.1 would only ever work
 * on the broadcast machine itself.
 *
 * Nothing is published to the path while TX is idle, so a player pointed here off air will simply
 * fail to connect. That is the honest behaviour; the panel says as much rather than handing over a
 * URL that looks broken.
 */
const mediaMtxHost = process.env.MEDIAMTX_PUBLIC_HOST || "127.0.0.1";
const onAirStreamUrls = {
  // Lowest latency of the three and what VLC opens most reliably — the default offered.
  rtsp: `rtsp://${mediaMtxHost}:${Number(process.env.MEDIAMTX_RTSP_PORT || 8554)}/live/onair`,
  // Plain HTTP, so it survives a firewall that only allows web traffic — but NOT currently
  // reachable on this machine: Timecode.Master binds :8888 on the LAN address specifically
  // (EMERALD_TIMECODE_MASTER_URL) and Windows routes the more specific binding first, so this
  // address reaches the generator and 404s. Built anyway; the UI offers it again once
  // MEDIAMTX_HLS_PORT moves it off 8888.
  hls: `http://${mediaMtxHost}:${Number(process.env.MEDIAMTX_HLS_PORT || 8888)}/live/onair/index.m3u8`,
  // For a downstream contribution link rather than local monitoring.
  srt: `srt://${mediaMtxHost}:${Number(process.env.MEDIAMTX_SRT_PORT || 8890)}?streamid=read:live/onair`,
};

// The single source of timecode for the whole backend. Measures this machine's clock offset
// against the Timecode System generator every couple of seconds, after which every timecode read
// is local arithmetic — see the header comment in timecodeMasterService.js for why it isn't
// polled per frame. Everything that used to format Node's own wall clock and call the result
// "timecode" now reads from here, so what Emerald displays and stores is the generator's timecode
// rather than an independently drifting guess.
const timecodeMaster = new TimecodeMasterService();
timecodeMaster.start();
obsIngest.timecodeMaster = timecodeMaster;
editCapture.timecodeMaster = timecodeMaster;

const timecodeLog = new TimecodeLogService(deltacastTx, timecodeMaster);
timecodeLog.start();

// Enforces RECORDING_SIZE_LIMIT and STORAGE_SIZE_LIMIT continuously, not just while a recording
// is running. ObsIngestService's own maintenance tick still handles the in-session case (it is
// the only thing that knows which segment ffmpeg currently has open); this covers the idle
// periods that tick never reached, which is how the backup volume ended up holding more than
// twice its configured limit.
const storageQuotaWatchdog = new StorageQuotaWatchdog({
  recordingsPath,
  getActiveSessionFolder: () => (obsIngest.recordingStatus.isRecording ? obsIngest.sessionFolderName : null),
  getBackupDir: () => resolveBackupDir().backupDir,
});
storageQuotaWatchdog.start();

// MediaMTX previously only ever started lazily, the first time someone clicked "Start" on the
// Capture page's own preview (webrtcPreview.start() below calls ensureMediaMtxRunning() itself).
// Now that TX's own ffmpeg process publishes RTSP directly to MediaMTX with no Node-managed relay
// in between, MediaMTX has to already be up *before* TX ever tries to push on air — otherwise
// ffmpeg blocks trying to open that RTSP output and never gets to producing the raw-frame output
// the SDI board actually needs either, breaking the real transmission, not just the preview.
webrtcPreview.ensureMediaMtxRunning();
Promise.all([
  webrtcPreview.waitForMediaMtxReady(webrtcPreview.rtspPort),
  webrtcPreview.waitForMediaMtxReady(webrtcPreview.whepPort),
]).catch((error) => {
  console.error("MediaMTX did not become ready at startup:", error.message);
});

// Keeps any emerald-tx-live.m3u8 left orphaned by a prior crash/restart in sync with its actual
// .ts segments (or finalized once it's gone idle), so playback/TX can't get stuck waiting forever
// on a stale playlist. See startOrphanTxPlaylistWatcher()'s comment in obsIngestService.js.
startOrphanTxPlaylistWatcher(recordingsPath, (folder) => folder === obsIngest.sessionFolderName && obsIngest.recordingStatus.isRecording);

db.getDataSource()
  .then(() => console.log(`Emerald database ready (${(process.env.DATABASE_TYPE || "sqlite").toLowerCase()})`))
  .then(() => registerPlugins(app))
  .then(() => registerRoutes(app))
  .then(start)
  .catch((error) => {
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
  await server.register(fastifyStatic, {
    root: exportsPath,
    prefix: "/exports/",
    decorateReply: false,
  });
  await server.register(fastifyStatic, {
    root: editCapturePath,
    prefix: "/edit-captures/",
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

  // Backs the Capture page's "Database Connect" indicator — real ping/SELECT 1 probes (not just
  // "has a client object ever been constructed", which is all /api/system/status's *Status()
  // getters report) against the app's 3 database-shaped connections: its own primary datastore,
  // the Redis instance backing BullMQ, and the standalone Postgres pool reserved for future use.
  server.get("/api/system/databases", async () => {
    const [db1, db2, db3] = await Promise.all([
      db.pingDataSource(),
      runtimeServices.pingRedis(),
      runtimeServices.pingPostgres(),
    ]);

    return {
      db1: { label: "Primary DB", ...db1 },
      db2: { label: "Redis", ...db2 },
      db3: { label: "Postgres", ...db3 },
    };
  });

  // Backs the Capture page's "Capture Logs" tab — tails services/eventLogService.js's append-only
  // logs.txt (recording/on-air lifecycle plus the warn/error entries logged alongside existing
  // error handling below) rather than pushing over a socket, matching this app's existing
  // poll-on-an-interval pattern (see CapturePage.vue's recorder.refresh() interval).
  server.get("/api/logs", async (request) => {
    const limit = Math.min(Number(request.query?.limit) || 200, 500);
    return readRecentEvents(limit);
  });

  // Tidal Lock (the Playback page's "keep TX auto-following the latest recording" toggle) is
  // frontend-only state (see sessionPlayback.ts — a Pinia store backed by localStorage, no
  // backend concept of it at all) — this just gives it a line in the Capture Logs tab when it's
  // switched, rather than logging anything about signal/reference lock, which doesn't exist here.
  server.post("/api/logs/tidal-lock", async (request) => {
    const engaged = Boolean(request.body?.engaged);
    logEvent(`Tidal Lock ${engaged ? "engaged" : "disengaged"}.`, "info", "TidalLock");
    return { ok: true };
  });

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

  server.get("/api/obs-recording/status", async () => ({
    ...obsIngest.recordingStatus,
    // Set once start() has run at least once (see obsIngestService.js); null beforehand.
    recordingSizeLimitBytes: obsIngest.recordingSizeLimitBytes ?? null,
  }));

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

  // Joins several selected Media Browser clips into one file carrying a SMPTE start timecode.
  // Stream-copied, so this is near-instant even for a long selection.
  server.post("/api/recordings/export", async (request, reply) => {
    try {
      const result = await clipExport.export(request.body || {});
      logEvent(
        `Exported ${result.clipCount} clip${result.clipCount === 1 ? "" : "s"} to ${result.fileName} @ ${result.startTimecode}`,
        "info",
        "Export",
      );
      return result;
    } catch (error) {
      return reply.code(400).send({ message: error.message });
    }
  });

  server.get("/api/recordings/exports", async () => clipExport.list());

  // Start timecode the export dialog prefills with: the earliest selected clip's real recorded
  // timecode, taken from the database rather than recomputed, so the export inherits exactly the
  // timecode that was stored when that segment was captured.
  server.get("/api/recordings/start-timecode", async (request, reply) => {
    const sessionFolder = path.basename(String(request.query.sessionFolder || ""));
    const fileName = path.basename(String(request.query.fileName || ""));
    if (!sessionFolder || !fileName) {
      return reply.code(400).send({ message: "sessionFolder and fileName are required." });
    }

    const session = await db.getSessionWithSegments(sessionFolder).catch(() => null);
    const frameRate = session?.frameRate || timecodeMaster.frameRate;

    // Segments are stored by their .mov name; the browser lists the .mp4 of the same index.
    const movName = fileName.replace(/\.mp4$/i, ".mov");
    const segment = session?.segments?.find((row) => row.movFileName === movName);

    return {
      // Falls back to the session's own start when the segment predates per-segment timecodes,
      // and to null when nothing is known — the dialog then asks the operator to type one rather
      // than inventing a plausible-looking value.
      startTimecode: segment?.startTimecode || session?.startTimecode || null,
      frameRate,
      timecodeSource: session?.timecodeSource ?? null,
    };
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
    const mp4Pattern = /^emerald-(\d+)\.mp4$/i;
    // emerald-tx-NNN.ts — the live HLS transport-stream segments obsIngestService writes
    // alongside the archival mp4s (see emerald-tx.m3u8/emerald-tx-live.m3u8). These aren't
    // user-facing clips; LiveEdit only wants them so it can scrub/play the still-recording tail
    // of an active session before its next mp4 segment has finished closing. Callers that only
    // want playable clips should filter on kind === "mp4".
    const tsPattern = /^emerald-tx-(\d+)\.ts$/i;

    const matches = files
      .map((fileName) => {
        const mp4Match = mp4Pattern.exec(fileName);
        if (mp4Match) return { fileName, index: Number(mp4Match[1]), kind: "mp4" };
        const tsMatch = tsPattern.exec(fileName);
        if (tsMatch) return { fileName, index: Number(tsMatch[1]), kind: "ts" };
        return null;
      })
      .filter(Boolean);

    // Read once for the whole listing, not per segment: this is what carries each segment's real
    // recorded timecode. Everything downstream that has to line material up — LiveEdit's timeline
    // placement, the on-air marker, the playback clock — has to agree on one reference, and the
    // only value expressed on the *generator's* clock rather than on whichever machine happens to
    // be asking is the one reconcileSegments stored here (see its timecodeAtLocalInstant call).
    // birthtime, which this endpoint also returns, is this machine's raw clock and drifts from it.
    const sessionRecord = await db.getSessionWithSegments(folder).catch(() => null);
    const recordFor = (fileName) => {
      const movName = fileName.replace(/\.(mp4|ts)$/i, ".mov");
      return sessionRecord?.segments?.find((segment) => segment.movFileName === movName) ?? null;
    };

    const segments = await mapWithConcurrency(matches, SEGMENT_PROBE_CONCURRENCY, async ({ fileName, kind }) => {
      const filePath = path.join(sessionDir, fileName);
      const stat = await fs.promises.stat(filePath);

      // Duration comes from the segment's own database record when it has one, and only from a
      // fresh probe when it does not.
      //
      // This used to probe every mp4 on every request. The Playback deck polls this endpoint every
      // five seconds and LiveEdit polls it too, so a session accumulated one ffprobe process per
      // segment per poll — twelve spawns every five seconds on a young session, and growing for as
      // long as the recording ran, all on the machine that is simultaneously capturing and
      // transmitting. Measured at 121ms of process churn per call for twelve segments.
      //
      // A finished segment's duration never changes, so re-measuring it is pure waste; persisting
      // what is measured means the cost falls to zero as the session fills in. Only the
      // still-recording tail is probed repeatedly, and that one genuinely can change.
      const record = recordFor(fileName);
      let probed = null;

      if (kind === "mp4" && record?.durationSeconds == null) {
        // The still-recording last segment can fail to probe (ffmpeg has not finalized it yet);
        // that is fine, it falls back to null and the frontend uses a placeholder duration.
        probed = await probeSegment(filePath).catch(() => null);

        // Write it back so no later request pays for this again. Fire and forget: a listing must
        // not fail because the database was busy.
        if (probed?.durationSeconds && record?.id) {
          db.updateSegmentProbe(record.id, probed)
            .catch((error) => app.log.error(error, "Failed to persist segment probe"));
        }
      }

      const durationSeconds = record?.durationSeconds ?? probed?.durationSeconds ?? null;

      return {
        fileName,
        kind,
        url: `/recordings/${folder}/${fileName}`,
        thumbnailUrl: kind === "mp4"
          ? `/api/obs-recordings/${encodeURIComponent(folder)}/${encodeURIComponent(fileName)}/thumbnail`
          : null,
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
        // The segment's real recorded timecode on the generator's clock — what a consumer should
        // position it by. Null for segments recorded before per-segment timecodes were stored, and
        // for .ts (the TX legs are never reconciled into the segment table); callers fall back to
        // createdAt for those.
        startTimecode: record?.startTimecode ?? null,
        frameRate: sessionRecord?.frameRate ?? null,
        durationSeconds,
        hasAudio: kind === "mp4" ? Boolean(record?.audioCodec ?? probed?.audioCodec) : null,
      };
    });

    // mp4 and ts segment indices are independent counters (different segment durations), so
    // ordering the merged list by actual file creation time is the only ordering that's
    // meaningful across both kinds.
    return segments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  });

  // Uncompressed, frame-accurate edit-capture pipeline for LiveEdit — a separate leg from the
  // obsIngest/rtmp recording pipeline above. DeltacastCaptureService owns the ffmpeg process (it's
  // the only thing with access to the raw SDI frame queue); editCapture here is a thin proxy for
  // control plus the Node-owned reconciliation/quota maintenance loop. See services/editCaptureService.js.
  server.get("/api/edit-capture/status", async (_request, reply) => {
    try {
      return await editCapture.status();
    } catch (error) {
      return reply.code(502).send({ message: error.message });
    }
  });

  server.post("/api/edit-capture/start", async (request, reply) => {
    try {
      return await editCapture.start(request.body || {});
    } catch (error) {
      return reply.code(502).send({ message: error.message });
    }
  });

  server.post("/api/edit-capture/stop", async (_request, reply) => {
    try {
      return await editCapture.stop();
    } catch (error) {
      return reply.code(502).send({ message: error.message });
    }
  });

  server.get("/api/edit-capture/sessions", async () => db.listRecentEditCaptureSessions());

  server.get("/api/edit-capture/sessions/:folder/segments", async (request, reply) => {
    const folder = path.basename(request.params.folder || "");
    const sessionDir = path.join(editCapturePath, folder);

    if (!folder || !isInsideDirectory(editCapturePath, sessionDir) || !fs.existsSync(sessionDir)) {
      return reply.code(404).send({ message: "Edit-capture session was not found." });
    }

    const files = await fs.promises.readdir(sessionDir);
    const masters = files
      .map((fileName) => {
        const match = EDIT_CAPTURE_MASTER_PATTERN.exec(fileName);
        return match ? { fileName, index: Number(match[1]) } : null;
      })
      .filter(Boolean);
    // Same bounded fan-out as the recording-session listing above — an edit-capture session
    // accumulates segments just as fast, so this endpoint had the identical spawn-storm problem.
    const segments = await mapWithConcurrency(masters, SEGMENT_PROBE_CONCURRENCY,
      async ({ fileName, index }) => {
        const stat = await fs.promises.stat(path.join(sessionDir, fileName));
        const proxyFileName = fileName.replace(EDIT_CAPTURE_MASTER_PATTERN, "editcapture-proxy-$1.mp4");
        const proxyPath = path.join(sessionDir, proxyFileName);
        const proxyStat = await fs.promises.stat(proxyPath).catch(() => null);
        // Probed off the H.264 proxy (not the rawvideo master — browsers/ffprobe both want the
        // decodable leg) so LiveEdit can convert this segment's duration into frames without a
        // second round trip. null when there's no proxy yet or the proxy hasn't finalized.
        const probed = proxyStat ? await probeSegment(proxyPath).catch(() => null) : null;

        return {
          index,
          fileName,
          sessionFolder: folder,
          // masterUrl is carried purely as a render/export reference — LiveEdit's browser never
          // fetches it directly (browsers have no decoder for raw UYVY). proxyUrl is what its
          // <video> elements actually play for scrubbing/cutting.
          masterUrl: `/edit-captures/${folder}/${fileName}`,
          proxyUrl: proxyStat ? `/edit-captures/${folder}/${proxyFileName}` : null,
          size: stat.size,
          proxySize: proxyStat ? proxyStat.size : null,
          createdAt: stat.birthtime.toISOString(),
          durationSeconds: probed?.durationSeconds ?? null,
          hasAudio: proxyStat ? Boolean(probed?.audioCodec) : null,
        };
      });

    return segments.sort((a, b) => a.index - b.index);
  });

  // Database-backed history — codec/timecode details verified against the actual files
  // (obsIngestService.js ffprobes each segment once it closes), not just directory listings.
  // See db/index.js and the RecordingSession/RecordingSegment/OnAirEvent entities.
  server.get("/api/db/sessions", async (request) => {
    const limit = Math.min(Number(request.query?.limit) || 50, 200);
    return db.listRecentSessions(limit);
  });

  server.get("/api/db/sessions/:folder", async (request, reply) => {
    const folder = path.basename(request.params.folder || "");
    const session = await db.getSessionWithSegments(folder);

    if (!session) {
      return reply.code(404).send({ message: "No database record for that recording session." });
    }

    return session;
  });

  server.get("/api/db/onair", async (request) => {
    const limit = Math.min(Number(request.query?.limit) || 50, 200);
    return db.listRecentOnAirEvents(limit);
  });

  server.post("/api/obs-recording/start", async (request, reply) => {
    const localInputError = rtmpIngest.getLocalInputError(request.body?.inputUrl);
    if (localInputError) {
      logEvent(`Recording start rejected — ${localInputError}`, "warn", "Recorder");
      return reply.code(400).send({ message: localInputError });
    }

    // Recorded alongside the session so a sync question months later can be answered against the
    // value that was actually in force. Best-effort: an unreachable capture service must not stop
    // a recording from starting, so a failure here just leaves the column null ("unknown").
    const audioOffsetMs = await deltacastTx.audioCalibration()
      .then((result) => result?.offsetMs ?? null)
      .catch(() => null);

    const { recordingStatus } = await obsIngest.start({ ...(request.body || {}), audioOffsetMs });
    sessionFrameBaseline = await deltacastTx.captureStatus()
      .then((status) => ({ framesReceived: status?.framesReceived ?? 0, framesDropped: status?.framesDropped ?? 0 }))
      .catch(() => ({ framesReceived: 0, framesDropped: 0 }));
    return recordingStatus;
  });

  server.post("/api/obs-recording/stop", async () => {
    const { recordingStatus } = obsIngest.stop();
    sessionFrameBaseline = null;
    logEvent("Recording stopped", "info", "Recorder");
    return recordingStatus;
  });

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

  // The WHEP URL itself is static — see the comment where onAirPreviewWhepUrl is declared. What
  // is publishing to it is not: `leg` says which SDI input DeltacastCaptureService's confidence
  // monitor is currently on and whether it has actually locked signal, so the Playback panel can
  // tell "pointed at RX4" from "receiving RX4". Null when that service is unreachable — the URL
  // still answers, because the page has to render either way.
  server.get("/api/onair-preview/status", async () => ({
    whepUrl: onAirPreviewWhepUrl,
    // The same feed for players that cannot speak WHEP — see onAirStreamUrls.
    streamUrls: onAirStreamUrls,
    leg: await deltacastTx.onAirPreviewStatus().catch(() => null),
  }));

  // Moves the confidence monitor to a different SDI input while everything is running. Previously
  // this was OnAirPreview:ChannelIndex in the capture service's appsettings.json, which only took
  // effect on a restart — not something anyone can do mid-transmission.
  server.post("/api/onair-preview/channel", async (request, reply) => {
    const { enabled, boardIndex, channelIndex } = request.body || {};

    try {
      const result = await deltacastTx.setOnAirPreviewChannel({ enabled, boardIndex, channelIndex });
      logEvent(`On-air preview input set — board=${boardIndex}, channel=RX${channelIndex}, enabled=${enabled !== false}`, "info", "TX");
      return result;
    } catch (error) {
      logEvent(`On-air preview input change failed — ${error.message}`, "warn", "TX");
      return reply.code(502).send({ message: error.message });
    }
  });

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

  // Network-facing timecode/health endpoint — meant for external systems on the LAN (not just
  // this app's own frontend) to poll, e.g. for sync/reference purposes. `timecode` is plain live
  // wall-clock time (same value the Capture page's own on-screen timecode shows). `onAir.timecode`
  // is different on purpose: when TX is playing the current session's broadcast-delayed live
  // playlist, what's actually on air right now was captured `broadcastDelaySeconds` ago, not
  // "now" — so it's offset backward by that amount rather than just echoing `timecode`. The
  // `delaySeconds` fields are each pipeline's own "time since it last actually processed a frame"
  // — a real, hardware-driven staleness signal (near 0 when healthy, growing if signal/output is
  // lost), not a measure of encode/network/buffering latency, which isn't independently
  // instrumented — that's what broadcastDelaySeconds/onAirTimecode is for.
  // Operator lip-sync calibration. Proxied straight through to DeltacastCaptureService, which
  // holds the value and applies it — Node keeps no copy of its own, so there is one source of
  // truth and no chance of the UI showing a number the ffmpeg legs aren't actually using.
  server.get("/api/audio-calibration", async (request, reply) => {
    try {
      return await deltacastTx.audioCalibration();
    } catch (error) {
      return reply.code(503).send({ message: error.message });
    }
  });

  server.post("/api/audio-calibration", async (request, reply) => {
    const offsetMs = Number(request.body?.offsetMs);
    if (!Number.isFinite(offsetMs)) {
      return reply.code(400).send({ message: "offsetMs must be a number." });
    }

    try {
      const result = await deltacastTx.setAudioCalibration(offsetMs);
      logEvent(`Audio calibration set to ${result.offsetMs}ms.`, "info", "Audio");
      return result;
    } catch (error) {
      return reply.code(503).send({ message: error.message });
    }
  });

  // Diagnostics: the generator's own view of itself and of every reader synced to it, alongside
  // our measured offset. Deliberately separate from /api/capture/timecode — that one has to stay
  // fast and local because the UI polls it continuously, whereas this one hits the generator over
  // the network and is only opened when someone is investigating a sync problem.
  server.get("/api/timecode/master", async () => {
    const snapshot = await timecodeMaster.masterSnapshot();
    return {
      emerald: timecodeMaster.status,
      // What we compute versus what the generator says at (as close as possible to) the same
      // instant — the two should never differ by more than a frame.
      emeraldTimecode: timecodeMaster.currentTimecode(),
      master: snapshot.timecode,
      readers: snapshot.readers,
    };
  });

  server.get("/api/capture/timecode", async () => {
    // "Now" on the generator's clock, and the generator's own frame rate — not this process's
    // wall clock and not a hardcoded 25. When the generator is unreachable this degrades to the
    // local clock, but says so via timecodeSource.lockState rather than pretending.
    const now = timecodeMaster.currentDate();
    const fps = timecodeMaster.frameRate;

    const [captureStatus, txStatus] = await Promise.all([
      deltacastTx.captureStatus().catch(() => null),
      deltacastTx.status().catch(() => null),
    ]);

    const delaySecondsSince = (lastFrameAt) => {
      if (!lastFrameAt) return null;
      return Math.max(0, (now.getTime() - new Date(lastFrameAt).getTime()) / 1000);
    };

    const recordingStatus = obsIngest.recordingStatus;
    const isRecordingNow = Boolean(recordingStatus?.isRecording);
    // Self-healing fallback: recording is active but there's no baseline yet (e.g. the backend
    // restarted mid-recording, or captureStatus was unreachable the instant /start ran) — start
    // counting from right now rather than showing a huge/wrong lifetime number.
    if (isRecordingNow && !sessionFrameBaseline) {
      sessionFrameBaseline = { framesReceived: captureStatus?.framesReceived ?? 0, framesDropped: captureStatus?.framesDropped ?? 0 };
    }
    const sessionFramesReceived = isRecordingNow
      ? Math.max(0, (captureStatus?.framesReceived ?? 0) - sessionFrameBaseline.framesReceived)
      : 0;
    const sessionFramesDropped = isRecordingNow
      ? Math.max(0, (captureStatus?.framesDropped ?? 0) - sessionFrameBaseline.framesDropped)
      : 0;
    const broadcastDelaySeconds = recordingStatus?.broadcastDelaySeconds || 0;
    // Only true while TX is actually playing the *current* session's delayed live feed — a
    // single clip or a finished-session loop isn't "capture from N seconds ago", it's old
    // footage with no live relationship to worry about, so it just echoes the live timecode.
    const isOnAirFromCurrentSessionLiveDelay = Boolean(
      recordingStatus?.isRecording &&
      txStatus?.isTransmitting &&
      typeof txStatus?.sourceUrl === "string" &&
      txStatus.sourceUrl.includes(obsIngest.sessionFolderName || "") &&
      txStatus.sourceUrl.endsWith(TX_LIVE_PLAYLIST_NAME)
    );
    // Where air actually is, measured rather than assumed.
    //
    // This used to be `now - broadcastDelaySeconds`, which only held while TX happened to open the
    // playlist near its live edge. A session opened at its first completed segment (see
    // /api/tx/start's startAt) is however old the recording already was behind live, not
    // `broadcastDelaySeconds` behind. The assumed value put LiveEdit's on-air marker near the live
    // edge while the transmission was actually playing material from much earlier — and everything
    // downstream of that marker (the freeze countdown, the air-EDL runway, which material is still
    // safe to cut) inherited the error.
    //
    // It is now fixed by where the transmission opened rather than measured from TX's frame
    // counter, which both removes the jitter that made this readout stall on screen and closes the
    // resume case the frame count could not express. See onAirContentTime and onAirAnchor.
    const onAirContentMs = isOnAirFromCurrentSessionLiveDelay
      ? onAirContentTime({
          recordingStartedAtMs: Date.parse(recordingStatus.startedAt),
          sessionDir: path.join(recordingsPath, obsIngest.sessionFolderName),
          segmentSeconds: recordingStatus.segmentSeconds,
          broadcastDelaySeconds,
          anchor: onAirAnchor?.folder === obsIngest.sessionFolderName ? onAirAnchor : null,
          nowMs: now.getTime(),
        })
      : null;

    // Falls back to the old assumption when the position can't be derived (playlist unreadable, no
    // frames sent yet) so this endpoint always answers with something usable.
    const onAirAtMs = onAirContentMs ?? now.getTime() - (isOnAirFromCurrentSessionLiveDelay ? broadcastDelaySeconds : 0) * 1000;
    const onAirDelaySeconds = isOnAirFromCurrentSessionLiveDelay
      ? Math.max(0, (now.getTime() - onAirAtMs) / 1000)
      : 0;
    const onAirTimecode = timecodeMaster.timecodeAt(new Date(onAirAtMs));

    return {
      timecode: timecodeMaster.timecodeAt(now),
      timestamp: now.toISOString(),
      fps,
      // Where this timecode actually came from: "master" with lockState LOCKED means it is the
      // generator's; "wallclock"/FREE_RUN means the generator was unreachable and this is the
      // local clock standing in; MISMATCH means the generator answered but its timecode disagrees
      // with ours by more than a frame, which in practice means the two machines' local clocks are
      // in different timezones. The UI shows this so an operator can tell a real timecode from a
      // fallback at a glance.
      timecodeSource: timecodeMaster.status,
      capture: {
        isCapturing: Boolean(captureStatus?.isCapturing),
        startedAt: captureStatus?.startedAt ?? null,
        // Scoped to the current recording session (see sessionFrameBaseline above) — 0 whenever
        // nothing is recording, not DeltacastSdkService's lifetime-since-boot counters.
        framesReceived: sessionFramesReceived,
        framesDropped: sessionFramesDropped,
        lastFrameAt: captureStatus?.lastFrameAt ?? null,
        delaySeconds: delaySecondsSince(captureStatus?.lastFrameAt),
        // Which physical Deltacast RX channel is configured for capture (see
        // DeltacastCaptureService's CaptureOptions.ChannelIndex / DeltacastSdkService.cs) — null
        // when DeltacastCaptureService itself is unreachable.
        channelIndex: captureStatus?.channelIndex ?? null,
        // Why capture isn't running when it isn't — most often "waiting for SDI signal lock on
        // RXn". Worth surfacing because every downstream symptom of a stalled capture (a black
        // Capture preview above all: no frames means nothing on Streaming:WebRtcRelayUrl, so the
        // WebRTC relay has no input to publish) looks identical from the browser.
        lastMessage: captureStatus?.lastMessage ?? (captureStatus ? null : "DeltacastCaptureService is unreachable on 127.0.0.1:5055."),
        // Detected signal format — null whenever there's no active, locked SDI signal (see
        // DeltacastSdkService.Status's hasDetectedFormat gate).
        sdiInterface: captureStatus?.sdiInterface ?? null,
        videoStandard: captureStatus?.videoStandard ?? null,
        videoWidth: captureStatus?.videoWidth ?? null,
        videoHeight: captureStatus?.videoHeight ?? null,
        videoFrameRate: captureStatus?.videoFrameRate ?? null,
        // FfmpegStreamingService's actual encode target, not a live-measured rate (see
        // DeltacastSdkService.cs's VideoBitrateKbps/AudioBitrateKbps comments).
        videoBitrateKbps: captureStatus?.videoBitrateKbps ?? null,
        audioBitrateKbps: captureStatus?.audioBitrateKbps ?? null,
        audioChannelDetected: Boolean(captureStatus?.audioChannelDetected),
        audioCapturedMs: captureStatus?.audioCapturedMs ?? 0,
        // Aggregate across every FrameQueueService consumer — video and embedded audio share this
        // one buffer, so there's no separate audio buffer reading.
        bufferInUse: captureStatus?.bufferInUse ?? null,
        bufferCapacity: captureStatus?.bufferCapacity ?? null,
      },
      onAir: {
        isTransmitting: Boolean(txStatus?.isTransmitting),
        startedAt: txStatus?.startedAt ?? null,
        framesSent: txStatus?.framesSent ?? 0,
        framesDropped: txStatus?.framesDropped ?? 0,
        lastFrameAt: txStatus?.lastFrameAt ?? null,
        delaySeconds: delaySecondsSince(txStatus?.lastFrameAt),
        timecode: onAirTimecode,
        broadcastDelaySeconds: onAirDelaySeconds,
        // Adaptive jitter-buffer delay TX is currently adding ahead of the SDI output — grows
        // automatically when VideoMaster reports dropped slots, eases back down when healthy.
        // See DeltacastTxService.AdaptBufferTarget.
        bufferDelayMs: txStatus?.bufferTargetMs ?? 0,
      },
    };
  });

  server.post("/api/tx/start", async (request, reply) => {
    const folder = path.basename(String(request.body?.folder || ""));
    const sessionDir = path.join(recordingsPath, folder);

    if (!folder) {
      logEvent("On-air start rejected — no recording folder selected", "warn", "TX");
      return reply.code(400).send({ message: "Select a recording folder in Playback before pushing on air." });
    }

    if (!isInsideDirectory(recordingsPath, sessionDir) || !fs.existsSync(sessionDir)) {
      logEvent(`On-air start rejected — recording session '${folder}' was not found`, "warn", "TX");
      return reply.code(404).send({ message: "Recording session was not found." });
    }

    // DeltacastTxService.StartAsync is a no-op that just returns the existing status when TX is
    // already transmitting — check first so a repeated/duplicate tx/start call (e.g. a UI retry)
    // doesn't log a second onair_events row for a session that never actually stopped.
    const wasAlreadyTransmitting = await deltacastTx.status().then((status) => Boolean(status?.isTransmitting)).catch(() => false);

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
        const status = await deltacastTx.start(filePath, { live: false, loop: false });
        logEvent(`On-air started — clip=${folder}/${requestedFileName}`, "info", "TX");
        if (!wasAlreadyTransmitting) {
          db.recordOnAirStart({
            startedAt: new Date(),
            startTimecode: timecodeMaster.currentTimecode(),
            sourceType: "clip",
            sourceFolder: folder,
            sourceFile: requestedFileName,
          }).catch((error) => app.log.error(error, "Failed to record on-air event"));
        }
        return status;
      } catch (error) {
        logEvent(`On-air start failed — clip=${folder}/${requestedFileName}: ${error.message}`, "error", "TX");
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

      // Hold air until the on-air countdown the Playback deck displays has actually elapsed.
      //
      // The playlist existing is NOT the same thing, and that is what this used to check. The
      // live TX leg is cut into 4-second .ts segments (TX_HLS_SEGMENT_SECONDS) rather than
      // 2-minute archival ones, so emerald-tx-live.m3u8 appears roughly one broadcast delay in —
      // around 68s at the defaults — while the deck is still counting down to segmentSeconds +
      // broadcastDelaySeconds, i.e. 180s. Anything that started air in that window (the manual
      // "Push On Air (Live)" button, which Tidal Lock's own client-side hold does not cover) put
      // the transmission out roughly two minutes before the operator was told it would go.
      //
      // Enforced here rather than only in the frontend because this is the point where air
      // actually starts: the button, an old browser tab and a direct API call all pass through it.
      const startedAtMs = Date.parse(obsIngest.recordingStatus.startedAt);
      const holdSeconds = (obsIngest.recordingStatus.segmentSeconds || 0)
        + (obsIngest.recordingStatus.broadcastDelaySeconds || 0);
      const readyAtMs = startedAtMs + holdSeconds * 1000;

      // An unparseable start time means the hold cannot be computed — don't let that block air.
      if (Number.isFinite(startedAtMs) && Date.now() < readyAtMs) {
        const remainingSeconds = Math.ceil((readyAtMs - Date.now()) / 1000);
        logEvent(`On-air start rejected — ${remainingSeconds}s left of the ${holdSeconds}s on-air hold for '${folder}'`, "warn", "TX");
        return reply.code(409).send({
          message: `Not airable yet — ${remainingSeconds}s left of the ${holdSeconds}s hold (${obsIngest.recordingStatus.segmentSeconds}s segment + ${obsIngest.recordingStatus.broadcastDelaySeconds}s broadcast delay).`,
        });
      }

      if (!fs.existsSync(txPlaylistPath)) {
        return reply.code(400).send({ message: "TX playlist isn't ready yet — wait for the first segment to finish and try again." });
      }

      // Where this push joins the playlist.
      //
      // The first time a session goes to air, the transmission opens on the first completed
      // segment — what the operator has just spent the whole hold waiting for is that segment, so
      // that is what air starts with. (This also makes onAirContentTime's arithmetic true: it
      // derives the on-air position from the first listed segment plus frames sent, which only
      // holds when TX actually started there.)
      //
      // A later push of the same session is a *resume*, not a fresh open, and must not replay
      // material that has already gone out — so it rejoins near the playlist's edge, which is the
      // broadcast-delay point by construction. Decided from the on-air event log rather than from
      // TX's own state, which is cleared by a stop and by a service restart.
      const hasAired = await db.hasAiredSession(folder).catch(() => false);
      const startAt = hasAired ? "delay" : "beginning";

      try {
        const status = await deltacastTx.start(txPlaylistPath, { live: true, startAt });
        onAirAnchor = {
          folder,
          startedAtMs: Date.now(),
          contentAtMs: playlistJoinContentMs(sessionDir, startAt, Date.parse(obsIngest.recordingStatus.startedAt)),
        };
        logEvent(`On-air started — live folder=${folder}, joining at ${startAt === "beginning" ? "the first completed segment" : "the delay point (resume)"}`, "info", "TX");
        if (!wasAlreadyTransmitting) {
          db.recordOnAirStart({
            startedAt: new Date(),
            startTimecode: timecodeMaster.currentTimecode(),
            sourceType: "live",
            sourceFolder: folder,
            broadcastDelaySeconds: obsIngest.recordingStatus.broadcastDelaySeconds ?? null,
          }).catch((error) => app.log.error(error, "Failed to record on-air event"));
        }
        return status;
      } catch (error) {
        logEvent(`On-air start failed — live folder=${folder}: ${error.message}`, "error", "TX");
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
      const status = await deltacastTx.start(playlistPath);
      logEvent(`On-air started — finished session folder=${folder}`, "info", "TX");
      if (!wasAlreadyTransmitting) {
        db.recordOnAirStart({
          startedAt: new Date(),
          startTimecode: timecodeMaster.currentTimecode(),
          sourceType: "finished-session",
          sourceFolder: folder,
        }).catch((error) => app.log.error(error, "Failed to record on-air event"));
      }
      return status;
    } catch (error) {
      logEvent(`On-air start failed — finished session folder=${folder}: ${error.message}`, "error", "TX");
      return reply.code(502).send({ message: error.message });
    }
  });

  server.post("/api/tx/stop", async (_request, reply) => {
    try {
      const status = await deltacastTx.stop();
      onAirAnchor = null;
      logEvent("On-air stopped", "info", "TX");
      db.recordOnAirStop({
        stoppedAt: new Date(),
        framesSent: status?.framesSent ?? null,
        framesDropped: status?.framesDropped ?? null,
        lastMessage: status?.lastMessage ?? null,
      }).catch((error) => app.log.error(error, "Failed to record on-air stop"));
      return status;
    } catch (error) {
      logEvent(`On-air stop failed — ${error.message}`, "error", "TX");
      return reply.code(502).send({ message: error.message });
    }
  });

  // Installed SDI boards and their channels, for the Recording/Playback configuration pickers.
  // Proxied straight through: DeltacastCaptureService owns the VideoMaster SDK and is the only
  // thing that can enumerate the hardware.
  server.get("/api/deltacast/boards", async (_request, reply) => {
    try {
      return await deltacastTx.boards();
    } catch (error) {
      // 200 with a reason rather than an error status: the pickers should degrade to "hardware
      // unavailable" text, not break the whole configuration panel.
      return reply.code(200).send({
        detectedBoardCount: 0,
        inventoryAvailable: false,
        boards: [],
        inUse: null,
        message: `DeltacastCaptureService is not reachable: ${error.message}`,
      });
    }
  });

  // --- Air EDL -----------------------------------------------------------------------------
  // Cutting material out of the transmission before it airs. The editing window is the broadcast
  // delay: writeTxPlaylist holds segments back until they are broadcastDelaySeconds old, and these
  // routes decide what of that held-back material actually makes it into the playlist TX plays.
  // See services/airEdlService.js for the ripple model and the safety rules.

  /**
   * Where air actually is, derived exactly as /api/capture/timecode derives it — the same number
   * LiveEdit draws its on-air marker at. Anything else means a panel showing an edit as safe while
   * these routes refuse it, which is precisely what used to happen.
   *
   * -Infinity when TX is not playing this session's live playlist: nothing of this recording has
   * gone out, so no part of it is too close to air. undefined when the position cannot be derived
   * at all, which leaves the EDL guards on their own pessimistic estimate rather than an invented
   * figure.
   */
  const measuredAirPointMs = async (session) => {
    const txStatus = await deltacastTx.status().catch(() => null);
    const isAiringThisSession = Boolean(
      txStatus?.isTransmitting
      && typeof txStatus?.sourceUrl === "string"
      && txStatus.sourceUrl.includes(session.folder)
      && txStatus.sourceUrl.endsWith(TX_LIVE_PLAYLIST_NAME),
    );

    if (!isAiringThisSession) return Number.NEGATIVE_INFINITY;

    const contentMs = onAirContentTime({
      recordingStartedAtMs: session.startedAtMs,
      sessionDir: session.sessionDir,
      segmentSeconds: session.segmentSeconds,
      broadcastDelaySeconds: session.broadcastDelaySeconds,
      anchor: onAirAnchor?.folder === session.folder ? onAirAnchor : null,
    });

    return contentMs === null ? undefined : contentMs;
  };

  /**
   * Turns a browser-facing media URL into a path on disk, or null if it does not name one.
   *
   * The result is handed to ffmpeg on the machine that is transmitting, so this is a containment
   * check rather than a convenience: only the recordings and exports roots are reachable, and only
   * through the prefixes the static handlers already serve them under.
   */
  const resolveMediaPath = (sourceUrl) => {
    if (typeof sourceUrl !== "string" || !sourceUrl) return null;

    const roots = [
      { prefix: "/recordings/", root: recordingsPath },
      { prefix: "/exports/", root: exportsPath },
      { prefix: "/edit-captures/", root: editCapturePath },
    ];

    for (const { prefix, root } of roots) {
      if (!sourceUrl.startsWith(prefix)) continue;

      const relative = decodeURIComponent(sourceUrl.slice(prefix.length)).split("?")[0];
      const resolved = path.resolve(root, relative);
      if (!isInsideDirectory(root, resolved) || !fs.existsSync(resolved)) return null;
      return resolved;
    }

    return null;
  };

  /** The session currently being recorded, which is the only one whose air can still be changed. */
  const activeAirSession = () => {
    if (!obsIngest.recordingStatus.isRecording || !obsIngest.sessionFolderName) return null;
    const startedAtMs = Date.parse(obsIngest.recordingStatus.startedAt);
    if (!Number.isFinite(startedAtMs)) return null;
    return {
      sessionDir: path.join(recordingsPath, obsIngest.sessionFolderName),
      folder: obsIngest.sessionFolderName,
      startedAtMs,
      broadcastDelaySeconds: obsIngest.broadcastDelaySeconds || 0,
      // The other half of the hold — see onAirContentTime's fallback.
      segmentSeconds: obsIngest.recordingStatus.segmentSeconds || 0,
    };
  };

  server.get("/api/air-edl", async (_request, reply) => {
    const session = activeAirSession();
    if (!session) {
      // Not an error: with nothing recording there is simply no editable window, and the editor
      // polls this to decide whether to offer cutting at all.
      return { active: false, cuts: [], remainingDelaySeconds: 0, spentSeconds: 0 };
    }

    try {
      return {
        active: true,
        sessionFolder: session.folder,
        recordingStartedAtMs: session.startedAtMs,
        broadcastDelaySeconds: session.broadcastDelaySeconds,
        ...describeAirEdl(session.sessionDir, { broadcastDelaySeconds: session.broadcastDelaySeconds }),
      };
    } catch (error) {
      return reply.code(500).send({ message: error.message });
    }
  });

  server.post("/api/air-edl/cut", async (request, reply) => {
    const session = activeAirSession();
    if (!session) {
      return reply.code(409).send({ message: "Nothing is recording, so there is no pre-air window to cut in." });
    }

    const { startMs, endMs } = request.body || {};

    const airPointMs = await measuredAirPointMs(session);

    const result = addAirCut(session.sessionDir, {
      startMs: Number(startMs),
      endMs: Number(endMs),
      recordingStartedAtMs: session.startedAtMs,
      broadcastDelaySeconds: session.broadcastDelaySeconds,
      airPointMs,
    });

    if (!result.ok) {
      // 409, not 400: the request is well-formed, it is the state of the transmission that makes
      // it impossible — and the operator can act on that (cut something else, cut less).
      return reply.code(409).send({ message: result.error });
    }

    // Rewrite immediately rather than waiting for the next tick. The whole value of a cut is that
    // it lands before the play point reaches it, and the operator is entitled to see it take hold.
    await obsIngest.updateLiveTxPlaylist();

    const seconds = ((Number(endMs) - Number(startMs)) / 1000).toFixed(1);
    logEvent(
      `Cut ${seconds}s from air — ${result.remainingDelaySeconds.toFixed(1)}s of delay left`,
      "warn",
      "AirEdit",
    );

    return { ...result.edl, remainingDelaySeconds: result.remainingDelaySeconds };
  });

  /**
   * Books a clip into the transmission at a timecode — the Playback panel's Clip Insert / Clip
   * Overlay. The source must resolve inside the media roots: this path ends up as an ffmpeg input
   * on the machine that is transmitting, so an unchecked one would read anything on disk.
   */
  server.post("/api/air-insert", async (request, reply) => {
    const session = activeAirSession();
    if (!session) {
      return reply.code(409).send({ message: "Nothing is recording, so there is no pre-air window to place a clip in." });
    }

    const { mode, atMs, sourceUrl } = request.body || {};
    const sourcePath = resolveMediaPath(sourceUrl);
    if (!sourcePath) {
      return reply.code(400).send({ message: "That clip could not be found in the recordings or exports folders." });
    }

    // Read off the file rather than trusted from the client: the booked duration decides how much
    // live material an overlay hides, and a wrong one would either cut the programme short or leave
    // the clip running over it.
    const probed = await probeSegment(sourcePath).catch(() => null);
    if (!probed?.durationSeconds) {
      return reply.code(400).send({ message: "Could not read how long that clip runs." });
    }

    const result = addAirInsert(session.sessionDir, {
      mode,
      atMs: Number(atMs),
      sourcePath,
      durationMs: probed.durationSeconds * 1000,
      recordingStartedAtMs: session.startedAtMs,
      broadcastDelaySeconds: session.broadcastDelaySeconds,
      airPointMs: await measuredAirPointMs(session),
    });

    if (!result.ok) return reply.code(409).send({ message: result.error });

    // Built and spliced on this rewrite rather than the next tick, so the operator sees the booking
    // take hold — and so a transcode failure surfaces now, while there is still time to act on it.
    await obsIngest.updateLiveTxPlaylist();

    logEvent(
      `Clip ${mode === "overlay" ? "overlaid on" : "inserted into"} air — ${result.insert.name} at ${timecodeMaster.timecodeAt(new Date(result.insert.atMs))} (${probed.durationSeconds.toFixed(1)}s)`,
      "warn",
      "AirEdit",
    );

    return result.edl;
  });

  server.delete("/api/air-insert/:id", async (request, reply) => {
    const session = activeAirSession();
    if (!session) {
      return reply.code(409).send({ message: "Nothing is recording." });
    }

    const result = removeAirInsert(session.sessionDir, request.params.id, {
      broadcastDelaySeconds: session.broadcastDelaySeconds,
      airPointMs: await measuredAirPointMs(session),
    });
    if (!result.ok) return reply.code(409).send({ message: result.error });

    await obsIngest.updateLiveTxPlaylist();
    logEvent(`Pulled a booked clip from air — ${request.params.id}`, "info", "AirEdit");
    return result.edl;
  });

  server.delete("/api/air-edl/cut/:id", async (request, reply) => {
    const session = activeAirSession();
    if (!session) {
      return reply.code(409).send({ message: "Nothing is recording." });
    }

    const result = removeAirCut(session.sessionDir, request.params.id, {
      broadcastDelaySeconds: session.broadcastDelaySeconds,
    });
    if (!result.ok) return reply.code(409).send({ message: result.error });

    await obsIngest.updateLiveTxPlaylist();
    logEvent(`Restored a cut to air — ${request.params.id}`, "info", "AirEdit");
    return result.edl;
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
  editCapture.stop().catch(() => {});
  rtmpIngest.stop();
  rtmpOut.stop();
  webrtcPreview.stopAll();
  timecodeLog.stop();
  stopSharedMediaMtx();
  runtimeServices.close()
    .finally(() => db.closeDataSource())
    .finally(() => app.close())
    .finally(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// obsIngest's ffmpeg (the actual recording) is a child process of this one, spawned without
// detaching — so on Windows, this process dying for ANY reason (an uncaught exception, an
// unhandled rejection, which Node treats as fatal by default since v15) takes the active
// recording down with it. A typical stateless web server can just crash and restart; this one
// can't — losing a live recording is worse than staying up after a bug we didn't anticipate. Log
// loudly (so the underlying issue is still visible/actionable) but never let it be the reason
// recording stops.
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception (backend staying up — an active recording depends on it):", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (backend staying up — an active recording depends on it):", reason);
});

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
