const { getDataSource, closeDataSource } = require("./dataSource");

async function getRepositories() {
  const ds = await getDataSource();
  return {
    sessions: ds.getRepository("RecordingSession"),
    segments: ds.getRepository("RecordingSegment"),
    onAirEvents: ds.getRepository("OnAirEvent"),
    editCaptureSessions: ds.getRepository("EditCaptureSession"),
    editCaptureSegments: ds.getRepository("EditCaptureSegment"),
  };
}

// --- Recording sessions -----------------------------------------------------------------

async function recordSessionStart(details) {
  const { sessions } = await getRepositories();
  const session = sessions.create({
    folderName: details.folderName,
    startedAt: details.startedAt,
    startTimecode: details.startTimecode,
    timecodeSource: details.timecodeSource ?? null,
    frameRate: details.frameRate,
    inputUrl: details.inputUrl,
    segmentSeconds: details.segmentSeconds,
    broadcastDelaySeconds: details.broadcastDelaySeconds,
    videoCodecArchival: details.videoCodecArchival,
    videoProfileArchival: details.videoProfileArchival,
    pixelFormatArchival: details.pixelFormatArchival,
    videoCodecPlayout: details.videoCodecPlayout,
    videoWidth: details.videoWidth ?? null,
    videoHeight: details.videoHeight ?? null,
    audioCodec: details.audioCodec ?? null,
    audioBitrateKbps: details.audioBitrateKbps ?? null,
    audioFileName: details.audioFileName ?? null,
    audioOffsetMs: details.audioOffsetMs ?? null,
    backupPath: details.backupPath ?? null,
    backupAvailable: Boolean(details.backupAvailable),
    status: "recording",
  });

  return sessions.save(session);
}

async function recordSessionStop(folderName, { stoppedAt, status, lastMessage }) {
  const { sessions } = await getRepositories();
  const session = await sessions.findOne({ where: { folderName } });
  if (!session) return null;

  session.stoppedAt = stoppedAt;
  session.status = status;
  if (lastMessage !== undefined) session.lastMessage = lastMessage;

  return sessions.save(session);
}

async function getSessionByFolderName(folderName) {
  const { sessions } = await getRepositories();
  return sessions.findOne({ where: { folderName } });
}

async function listRecentSessions(limit = 50) {
  const { sessions } = await getRepositories();
  return sessions.find({
    order: { startedAt: "DESC" },
    take: limit,
  });
}

async function getSessionWithSegments(folderName) {
  const { sessions } = await getRepositories();
  return sessions.findOne({
    where: { folderName },
    relations: { segments: true },
    order: { segments: { segmentIndex: "ASC" } },
  });
}

// --- Recording segments ------------------------------------------------------------------

// Best-effort upsert keyed on (session, segmentIndex) — called repeatedly from the maintenance
// tick as it reconciles whatever .mov/.mp4 files actually exist on disk, so this must be safe to
// call again for a segment it already knows about (just refreshes size fields).
async function upsertSegment(sessionId, details) {
  const { segments } = await getRepositories();
  let segment = await segments.findOne({
    where: { session: { id: sessionId }, segmentIndex: details.segmentIndex },
  });

  if (!segment) {
    segment = segments.create({
      session: { id: sessionId },
      segmentIndex: details.segmentIndex,
      movFileName: details.movFileName,
      mp4FileName: details.mp4FileName,
      startTimecode: details.startTimecode ?? null,
      createdAt: details.createdAt,
    });
  }

  if (details.movSizeBytes !== undefined) segment.movSizeBytes = details.movSizeBytes;
  if (details.mp4SizeBytes !== undefined) segment.mp4SizeBytes = details.mp4SizeBytes;

  return segments.save(segment);
}

async function updateSegmentProbe(segmentId, probed) {
  const { segments } = await getRepositories();
  await segments.update(segmentId, {
    durationSeconds: probed.durationSeconds ?? null,
    videoCodec: probed.videoCodec ?? null,
    audioCodec: probed.audioCodec ?? null,
    audioSampleRate: probed.audioSampleRate ?? null,
    audioChannels: probed.audioChannels ?? null,
    probedAt: new Date(),
  });

  // Segment-level ground truth about whether audio is really present rolls up to the session
  // once, the first time any segment confirms it — cheaper than re-probing every segment.
  if (probed.audioCodec) {
    const segment = await segments.findOne({ where: { id: segmentId }, relations: { session: true } });
    if (segment?.session && segment.session.audioPresent !== true) {
      const { sessions } = await getRepositories();
      await sessions.update(segment.session.id, {
        audioPresent: true,
        audioCodec: segment.session.audioCodec || probed.audioCodec,
        audioSampleRate: probed.audioSampleRate ?? null,
        audioChannels: probed.audioChannels ?? null,
      });
    }
  }
}

async function getUnprobedSegmentIds(sessionId) {
  const { segments } = await getRepositories();
  const rows = await segments.find({
    where: { session: { id: sessionId } },
    select: { id: true, segmentIndex: true, movFileName: true, probedAt: true },
  });
  return rows.filter((row) => !row.probedAt);
}

// --- Edit-capture sessions ---------------------------------------------------------------

async function recordEditCaptureSessionStart(details) {
  const { editCaptureSessions } = await getRepositories();
  const session = editCaptureSessions.create({
    folderName: details.folderName,
    startedAt: details.startedAt,
    startTimecode: details.startTimecode,
    timecodeSource: details.timecodeSource ?? null,
    frameRate: details.frameRate,
    segmentSeconds: details.segmentSeconds,
    videoCodec: details.videoCodec,
    pixelFormat: details.pixelFormat,
    videoWidth: details.videoWidth ?? null,
    videoHeight: details.videoHeight ?? null,
    audioCodec: details.audioCodec ?? null,
    audioSampleRate: details.audioSampleRate ?? null,
    audioChannels: details.audioChannels ?? null,
    audioFileName: details.audioFileName ?? null,
    audioOffsetMs: details.audioOffsetMs ?? null,
    proxyVideoCodec: details.proxyVideoCodec ?? "h264",
    proxyBitrateKbps: details.proxyBitrateKbps ?? null,
    status: "recording",
  });

  return editCaptureSessions.save(session);
}

async function recordEditCaptureSessionStop(folderName, { stoppedAt, status, lastMessage }) {
  const { editCaptureSessions } = await getRepositories();
  const session = await editCaptureSessions.findOne({ where: { folderName } });
  if (!session) return null;

  session.stoppedAt = stoppedAt;
  session.status = status;
  if (lastMessage !== undefined) session.lastMessage = lastMessage;

  return editCaptureSessions.save(session);
}

async function getEditCaptureSessionByFolderName(folderName) {
  const { editCaptureSessions } = await getRepositories();
  return editCaptureSessions.findOne({ where: { folderName } });
}

async function listRecentEditCaptureSessions(limit = 50) {
  const { editCaptureSessions } = await getRepositories();
  return editCaptureSessions.find({
    order: { startedAt: "DESC" },
    take: limit,
  });
}

async function getEditCaptureSessionWithSegments(folderName) {
  const { editCaptureSessions } = await getRepositories();
  return editCaptureSessions.findOne({
    where: { folderName },
    relations: { segments: true },
    order: { segments: { segmentIndex: "ASC" } },
  });
}

// Best-effort upsert keyed on (session, segmentIndex) — called repeatedly from the maintenance
// tick as it reconciles whatever editcapture-NNN.mov/editcapture-proxy-NNN.mp4 files actually
// exist on disk, so this must be safe to call again for a segment it already knows about (just
// refreshes size fields).
async function upsertEditCaptureSegment(sessionId, details) {
  const { editCaptureSegments } = await getRepositories();
  let segment = await editCaptureSegments.findOne({
    where: { session: { id: sessionId }, segmentIndex: details.segmentIndex },
  });

  if (!segment) {
    segment = editCaptureSegments.create({
      session: { id: sessionId },
      segmentIndex: details.segmentIndex,
      fileName: details.fileName,
      proxyFileName: details.proxyFileName ?? null,
      startTimecode: details.startTimecode ?? null,
      createdAt: details.createdAt,
    });
  }

  if (details.sizeBytes !== undefined) segment.sizeBytes = details.sizeBytes;
  if (details.proxySizeBytes !== undefined) segment.proxySizeBytes = details.proxySizeBytes;

  return editCaptureSegments.save(segment);
}

async function updateEditCaptureSegmentProbe(segmentId, probed) {
  const { editCaptureSegments } = await getRepositories();
  await editCaptureSegments.update(segmentId, {
    durationSeconds: probed.durationSeconds ?? null,
    videoCodec: probed.videoCodec ?? null,
    audioCodec: probed.audioCodec ?? null,
    probedAt: new Date(),
  });
}

async function getUnprobedEditCaptureSegmentIds(sessionId) {
  const { editCaptureSegments } = await getRepositories();
  const rows = await editCaptureSegments.find({
    where: { session: { id: sessionId } },
    select: { id: true, segmentIndex: true, fileName: true, probedAt: true },
  });
  return rows.filter((row) => !row.probedAt);
}

// --- On-air events -------------------------------------------------------------------------

async function recordOnAirStart(details) {
  const { onAirEvents } = await getRepositories();
  const event = onAirEvents.create({
    startedAt: details.startedAt,
    startTimecode: details.startTimecode,
    sourceType: details.sourceType,
    sourceFolder: details.sourceFolder ?? null,
    sourceFile: details.sourceFile ?? null,
    broadcastDelaySeconds: details.broadcastDelaySeconds ?? null,
  });

  return onAirEvents.save(event);
}

// Closes out whichever on-air event is still open (no stoppedAt) — there's only ever one TX
// channel, so at most one row is ever open at a time.
async function recordOnAirStop({ stoppedAt, framesSent, framesDropped, lastMessage }) {
  const { onAirEvents } = await getRepositories();
  const open = await onAirEvents.findOne({ where: { stoppedAt: null }, order: { startedAt: "DESC" } });
  if (!open) return null;

  open.stoppedAt = stoppedAt;
  open.framesSent = framesSent ?? null;
  open.framesDropped = framesDropped ?? null;
  if (lastMessage !== undefined) open.lastMessage = lastMessage;

  return onAirEvents.save(open);
}

/**
 * Whether this session has ever been to air before. Decides where a live transmission joins its
 * playlist: the first push of a session opens at the first completed segment, a later one rejoins
 * near the delay point instead of replaying material that has already gone out.
 */
async function hasAiredSession(sourceFolder) {
  if (!sourceFolder) return false;
  const { onAirEvents } = await getRepositories();
  const count = await onAirEvents.count({ where: { sourceFolder } });
  return count > 0;
}

async function listRecentOnAirEvents(limit = 50) {
  const { onAirEvents } = await getRepositories();
  return onAirEvents.find({
    order: { startedAt: "DESC" },
    take: limit,
  });
}

// Real connectivity probe for the Capture page's "Database Connect" indicator — the app's own
// primary datastore (sqlite by default, mysql for a multi-machine deployment; see dataSource.js).
async function pingDataSource() {
  const startedAt = Date.now();
  try {
    const ds = await getDataSource();
    await ds.query("SELECT 1");
    const options = ds.options;
    const host = options.type === "better-sqlite3" ? "local file" : `${options.host}:${options.port}`;
    return { connected: true, latencyMs: Date.now() - startedAt, type: options.type, host };
  } catch (error) {
    return { connected: false, latencyMs: null, type: null, host: null, error: error.message };
  }
}

module.exports = {
  getDataSource,
  closeDataSource,
  pingDataSource,
  recordSessionStart,
  recordSessionStop,
  getSessionByFolderName,
  listRecentSessions,
  getSessionWithSegments,
  upsertSegment,
  updateSegmentProbe,
  getUnprobedSegmentIds,
  recordEditCaptureSessionStart,
  recordEditCaptureSessionStop,
  getEditCaptureSessionByFolderName,
  listRecentEditCaptureSessions,
  getEditCaptureSessionWithSegments,
  upsertEditCaptureSegment,
  updateEditCaptureSegmentProbe,
  getUnprobedEditCaptureSegmentIds,
  recordOnAirStart,
  recordOnAirStop,
  hasAiredSession,
  listRecentOnAirEvents,
};
