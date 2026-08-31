const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { probeSegment } = require("./segmentProbeService");

/**
 * The air EDL — cuts an operator has committed against material that has been captured but has not
 * yet gone out.
 *
 * This is what makes LiveEdit's timeline an edit of the transmission rather than a view of it.
 * The mechanism is the broadcast delay that already exists: writeTxPlaylist holds each .ts segment
 * out of emerald-tx-live.m3u8 until it is `broadcastDelaySeconds` old, so at any moment there is a
 * rolling window of material that is recorded, playable, and still changeable. TX reads that
 * playlist off disk (DeltacastCaptureService decodes it straight into the SDI output), so removing
 * a range from the playlist before the play point reaches it removes it from the broadcast.
 *
 * RIPPLE, NOT LIFT. A cut shortens the playlist; nothing is substituted for it. The material after
 * the cut therefore airs earlier than it otherwise would, and the gap between capture and air —
 * the editing window itself — shrinks by exactly the length of the cut. Cutting spends delay. That
 * is the same bargain a profanity delay makes, and it is self-limiting in a way an operator can
 * reason about: `remainingDelaySeconds` below is the budget, and once it is gone there is no room
 * left to edit in until the transmission ends. MIN_REMAINING_DELAY_SECONDS refuses the cut that
 * would spend the last of it, because a playlist that runs out from under TX is dead air.
 *
 * FRAME ACCURATE. Segments falling entirely inside a cut are simply dropped from the playlist.
 * Segments the cut lands in the middle of are re-encoded into trimmed substitutes (see
 * buildTrimmedSegment) — a stream copy could only cut on keyframes, which at this segment length
 * means whole-segment precision. The re-encode is cached on disk by a deterministic name, because
 * the playlist is rewritten on a timer and re-encoding the same trim every tick would peg the CPU
 * of the machine that is also recording and transmitting.
 */

/** Stored next to the media it describes, so a session folder carries its own edit decisions. */
const EDL_FILE_NAME = "air-edl.json";

/**
 * Continuity group for the recorder's own segments. They come off one HLS muxer, so consecutive
 * indices carry consecutive timestamps — see isTimelineBreak in obsIngestService.
 */
const LIVE_GROUP = "live";

/** Prefix for generated trim substitutes, distinct from the recorder's own emerald-tx-NNN.ts. */
const TRIM_PREFIX = "emerald-txcut";

/**
 * Refuse a cut that would leave less than this much runway between air and the end of eligible
 * material. TX stalls — dead air — if the playlist empties, and a cut is irreversible once the
 * play point has passed it.
 */
const MIN_REMAINING_DELAY_SECONDS = 8;

/**
 * A cut must land at least this far ahead of the current air point. The playlist is only rewritten
 * on a tick and TX reads it asynchronously, so a cut placed right at the play point is a race
 * against material that may already be in flight.
 */
const MIN_LEAD_SECONDS = 4;

/** Trim shorter than this is not worth a re-encode; the boundary is snapped to the segment edge. */
const MIN_TRIM_SECONDS = 0.2;

function edlPath(sessionDir) {
  return path.join(sessionDir, EDL_FILE_NAME);
}

/**
 * Reads a session's EDL. A missing or unreadable file means "no cuts" rather than an error: the
 * playlist writer runs on a timer in the recording hot path and must never be taken down by a
 * malformed sidecar.
 */
function loadEdl(sessionDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(edlPath(sessionDir), "utf8"));
    const cuts = Array.isArray(parsed?.cuts) ? parsed.cuts : [];
    const inserts = Array.isArray(parsed?.inserts) ? parsed.inserts : [];
    return {
      cuts: cuts
        .filter((cut) => Number.isFinite(cut?.startMs) && Number.isFinite(cut?.endMs) && cut.endMs > cut.startMs)
        .sort((a, b) => a.startMs - b.startMs),
      inserts: inserts
        .filter((insert) =>
          Number.isFinite(insert?.atMs)
          && Number.isFinite(insert?.durationMs)
          && insert.durationMs > 0
          && typeof insert?.sourcePath === "string"
          && (insert.mode === "insert" || insert.mode === "overlay"))
        .sort((a, b) => a.atMs - b.atMs),
    };
  } catch {
    return { cuts: [], inserts: [] };
  }
}

/**
 * The ranges of live material an overlay hides.
 *
 * An overlay plays for its own length *in place of* what was captured underneath it, so from the
 * playlist's point of view that span is cut — the difference from a real cut being that the clip is
 * spliced into the hole rather than the material after it rippling earlier. Expressing it this way
 * means the existing cut machinery does the boundary trimming, and an overlay landing mid-segment
 * gets the same frame accuracy a cut does.
 *
 * An insert hides nothing: it stops the live, plays, and hands back, so the material underneath is
 * still to come.
 *
 * The range is the length the clip was booked at, which the transcode can overshoot by up to one
 * keyframe interval — the segment muxer finishes the segment it is in rather than stopping mid-way.
 * Measured at up to ~0.2s on a 4s interval. An overlay can therefore run a few frames past the
 * material it covers, shifting everything after it that much later. That is a uniform shift, not a
 * glitch or a repeat, and the broadcast delay absorbs it; worth knowing before treating an overlay
 * as frame-exact against the live underneath.
 */
function overlayCoveredRanges(edl) {
  return edl.inserts
    .filter((insert) => insert.mode === "overlay")
    .map((insert) => ({ startMs: insert.atMs, endMs: insert.atMs + insert.durationMs }));
}

function saveEdl(sessionDir, edl) {
  fs.writeFileSync(edlPath(sessionDir), JSON.stringify(edl, null, 2), "utf8");
}

/** Total duration removed by an EDL, in seconds — the delay already spent. */
function totalCutSeconds(edl) {
  return mergeRanges(edl.cuts).reduce((sum, cut) => sum + (cut.endMs - cut.startMs), 0) / 1000;
}

/**
 * Overlapping cuts collapse into one. Two operators (or one operator twice) can select overlapping
 * ranges, and counting the overlap twice would both over-report the delay spent and, worse, make
 * the playlist arithmetic below subtract the same span from two different segments.
 */
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs);
  const merged = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs);
    } else {
      merged.push({ startMs: range.startMs, endMs: range.endMs });
    }
  }

  return merged;
}

/**
 * Wall-clock span a TX segment covers.
 *
 * Derived from the recording's start instant plus the segment index rather than from the file's
 * mtime: the HLS muxer is configured for fixed-length segments, so index arithmetic is exact by
 * construction, while mtime is when the file was last *written* and drifts by however long the
 * muxer took to flush. Frame-accurate trimming cannot be built on a timebase that is a few hundred
 * milliseconds out.
 */
function segmentSpan(index, recordingStartedAtMs, targetDurationSeconds) {
  const startMs = recordingStartedAtMs + index * targetDurationSeconds * 1000;
  return { startMs, endMs: startMs + targetDurationSeconds * 1000 };
}

/**
 * Subtracts the cut ranges from one segment's span, returning the pieces that survive.
 *
 * Returns [] when the segment is entirely inside a cut (drop it), a single full-width piece when
 * no cut touches it (use the original file untouched), or one/two partial pieces when a cut lands
 * inside it (each needs a trimmed substitute).
 */
function survivingPieces(span, cuts) {
  let pieces = [{ startMs: span.startMs, endMs: span.endMs }];

  for (const cut of cuts) {
    const next = [];
    for (const piece of pieces) {
      // No overlap — the piece passes through untouched.
      if (cut.endMs <= piece.startMs || cut.startMs >= piece.endMs) {
        next.push(piece);
        continue;
      }
      // Head survives.
      if (cut.startMs > piece.startMs) next.push({ startMs: piece.startMs, endMs: cut.startMs });
      // Tail survives.
      if (cut.endMs < piece.endMs) next.push({ startMs: cut.endMs, endMs: piece.endMs });
      // Anything else is fully covered and drops out.
    }
    pieces = next;
  }

  // Sub-frame slivers left by a cut that lands almost exactly on a boundary are not worth an
  // ffmpeg run and would show as a single-frame flash on air.
  return pieces.filter((piece) => piece.endMs - piece.startMs >= MIN_TRIM_SECONDS * 1000);
}

/**
 * Deterministic name for a trimmed substitute. Same segment and same trim offsets always produce
 * the same file name, which is what lets the once-a-second playlist rewrite skip the re-encode
 * when the file is already on disk.
 */
function trimFileName(segmentFileName, offsetMs, durationMs) {
  const base = segmentFileName.replace(/\.ts$/i, "");
  return `${TRIM_PREFIX}-${base}-${Math.round(offsetMs)}-${Math.round(durationMs)}.ts`;
}

/**
 * Re-encodes part of a segment into a standalone .ts.
 *
 * Re-encode rather than `-c copy` because a stream copy can only start at a keyframe, and at this
 * segment length that would round every cut to the nearest whole segment — exactly the precision
 * this function exists to avoid. Output parameters deliberately mirror what the recorder writes so
 * the substitute drops into the same playlist without a codec or geometry change at the join.
 */
function buildTrimmedSegment({ ffmpegPath, sessionDir, segmentFileName, offsetMs, durationMs }) {
  const outputName = trimFileName(segmentFileName, offsetMs, durationMs);
  const outputPath = path.join(sessionDir, outputName);

  // Already built by an earlier tick — the common case, since the playlist is rewritten far more
  // often than cuts are made.
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    return Promise.resolve(outputName);
  }

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    // After -i, so the seek is decode-accurate rather than snapped to the preceding keyframe.
    "-i", path.join(sessionDir, segmentFileName),
    "-ss", (offsetMs / 1000).toFixed(3),
    "-t", (durationMs / 1000).toFixed(3),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    // Every frame a keyframe would bloat the file; one at the head is what the demuxer needs to
    // start cleanly at the join.
    "-g", "50",
    "-c:a", "aac",
    "-b:a", "192k",
    "-muxdelay", "0",
    "-f", "mpegts",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) return resolve(outputName);
      // A failed trim must not leave a truncated file behind that the existence check above would
      // later mistake for a finished one.
      try { fs.unlinkSync(outputPath); } catch { /* nothing to remove */ }
      reject(new Error(stderr.slice(-300) || `ffmpeg exited ${code}`));
    });
  });
}

/** Prefix for the .ts pieces an inserted clip is transcoded into. */
const INSERT_PREFIX = "emerald-txins";

/** A stable, filename-safe digest of the insert's identity, so the transcode is cached on disk. */
function insertKey(insert) {
  const basis = `${insert.sourcePath}|${insert.mode}|${Math.round(insert.atMs)}|${Math.round(insert.durationMs)}`;
  let hash = 0;
  for (let index = 0; index < basis.length; index += 1) {
    hash = (hash * 31 + basis.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Transcodes an inserted clip into .ts pieces the TX playlist can splice in, returning them in
 * play order as `{ fileName, durationSeconds }`.
 *
 * Re-encoded, never stream-copied, and forced to the recorder's own geometry and frame rate. TX
 * decodes the whole playlist into one raw UYVY pipe feeding a fixed SDI stream — a clip that
 * arrives at a different resolution or frame rate does not merely look wrong, it desynchronises
 * that pipe and takes the transmission down. Anything spliced into this playlist has to be
 * indistinguishable from what the recorder writes.
 *
 * Segmented rather than emitted as one long .ts because EXT-X-TARGETDURATION must be at least as
 * large as every EXTINF in the playlist, and the recorder sets it from its own 4s segments.
 *
 * The whole set is cached under a deterministic name: the playlist is rewritten every tick, and
 * re-encoding a clip each time would peg the CPU of the machine that is also recording and
 * transmitting.
 */
function buildInsertSegments({ ffmpegPath, sessionDir, insert, targetDurationSeconds, width, height, frameRate }) {
  const key = insertKey(insert);
  const prefix = `${INSERT_PREFIX}-${key}`;
  const donePath = path.join(sessionDir, `${prefix}.done`);

  // The finished set, read back from the marker rather than re-measured.
  //
  // This is the hot path, not the cold one: the playlist is rewritten twice a second for the whole
  // life of a transmission, and every one of those writes lands here for every booked clip. It used
  // to answer by listing the session folder (hundreds of files, synchronously) and then spawning an
  // ffprobe per piece to read durations it had already established once — six processes a second
  // for a nine-second clip, on the machine that is simultaneously capturing and transmitting, which
  // is exactly the kind of load that shows up as dropped capture frames. The marker now carries the
  // pieces and their measured durations, so a cache hit is one small file read and nothing else.
  const cached = readInsertManifest(donePath);
  if (cached) return Promise.resolve(cached.map((piece) => ({ ...piece, group: `ins:${insert.id}`, seq: piece.seq })));

  const existing = fs.readdirSync(sessionDir)
    .filter((fileName) => fileName.startsWith(`${prefix}-`) && fileName.endsWith(".ts"))
    .sort();

  // Clear a partial set before rebuilding, so a half-finished attempt can never be mistaken for a
  // complete one by the listing above.
  for (const fileName of existing) {
    try { fs.unlinkSync(path.join(sessionDir, fileName)); } catch { /* already gone */ }
  }

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", insert.sourcePath,
    // Never air more than the operator was told it would take. A source longer than the booked
    // duration is cut off here rather than running over into live material.
    "-t", (insert.durationMs / 1000).toFixed(3),
    "-map", "0:v:0",
    // Optional: a silent clip still has to carry an audio track, or the join drops the audio
    // stream mid-playlist and TX embeds silence for the rest of the transmission.
    "-map", "0:a:0?",
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${frameRate},setsar=1`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    // Matched to what the capture encoder actually produces, read off a real segment: Constrained
    // Baseline, level 4.0, no B-frames, ~8 Mbps. Geometry alone is not enough. TX decodes the whole
    // playlist through one decoder into a hardware-paced SDI pipe, so a clip encoded at a different
    // profile makes that decoder reinitialise mid-transmission, and B-frames add reorder delay the
    // live stream does not have. Both show up on air as the picture hesitating and stuttering
    // across the join — which is exactly what leaving these at libx264's defaults (High profile,
    // B-frames on) produced.
    "-profile:v", "baseline",
    "-level", "4.0",
    "-bf", "0",
    // A steady rate rather than a quality target, for the same reason: TX's jitter buffer is sized
    // against the live stream's bitrate, and a VBR clip swinging well above it starves the SDI
    // submit loop while the decoder catches up.
    "-b:v", "8000k",
    "-maxrate", "8000k",
    "-bufsize", "16000k",
    // Scene-change keyframes would land off the segment boundaries forced below, leaving pieces
    // that start mid-GOP.
    "-sc_threshold", "0",
    "-g", String(Math.max(1, Math.round(frameRate * targetDurationSeconds))),
    // The segment muxer can only cut on a keyframe, so without one placed exactly at each boundary
    // it overruns — a 9s clip came out as 4.02s + 5.08s rather than 4 + 4 + 1. That matters twice
    // over: EXT-X-TARGETDURATION must be at least as long as every entry in the playlist, and a
    // piece longer than the recorder's own segments would break that guarantee for the whole file.
    "-force_key_frames", `expr:gte(t,n_forced*${targetDurationSeconds})`,
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    // Guarantees an audio track even when the source has none, so every entry in the playlist
    // presents the same stream layout to TX's decoder.
    "-shortest",
    "-muxdelay", "0",
    "-f", "segment",
    "-segment_time", String(targetDurationSeconds),
    "-segment_format", "mpegts",
    // Deliberately NOT -reset_timestamps: the clip's own pieces have to run as one continuous
    // timeline. Restarting each at zero makes every boundary inside the clip look like a timeline
    // break to the demuxer, which stalls it several times over instead of once at the join.
    path.join(sessionDir, `${prefix}-%03d.ts`),
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      const produced = fs.existsSync(sessionDir)
        ? fs.readdirSync(sessionDir).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".ts")).sort()
        : [];

      if (code !== 0 || !produced.length) {
        for (const fileName of produced) {
          try { fs.unlinkSync(path.join(sessionDir, fileName)); } catch { /* already gone */ }
        }
        reject(new Error(stderr.slice(-300) || `ffmpeg exited ${code}`));
        return;
      }

      describeInsertPieces(sessionDir, produced, targetDurationSeconds, insert.durationMs, insert.id)
        .then((pieces) => {
          // Written last, and holding the pieces themselves: its presence is what marks the set
          // finished, and its contents are what spare every later tick from measuring again.
          try {
            fs.writeFileSync(donePath, JSON.stringify(pieces), "utf8");
          } catch {
            // Unwritable marker only costs a rebuild next tick; it must not fail the clip.
          }
          resolve(pieces);
        }, reject);
    });
  });
}

/**
 * The pieces recorded in a finished set's marker, or null if there is no usable one.
 *
 * Tolerates a marker that is missing, empty (the format an earlier build wrote) or malformed by
 * treating all three as "not built" — the caller then rebuilds, which is correct and cheap once.
 */
function readInsertManifest(donePath) {
  try {
    const raw = fs.readFileSync(donePath, "utf8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    if (!parsed.every((piece) => typeof piece?.fileName === "string" && piece.durationSeconds > 0)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Reads each generated piece's real duration for its EXTINF.
 *
 * Measured, not computed. Dividing the booked length by the segment length looks equivalent and is
 * not: the muxer cuts on keyframes, so the pieces come out slightly uneven, and a playlist whose
 * declared durations do not match its media drifts TX's timing against the transmission it is
 * supposed to be feeding. Falls back to an even division only if a piece cannot be probed, which is
 * better than refusing to air a clip that exists on disk.
 */
async function describeInsertPieces(sessionDir, fileNames, targetDurationSeconds, totalDurationMs, insertId) {
  const probed = await Promise.all(fileNames.map(async (fileName) => {
    try {
      const result = await probeSegment(path.join(sessionDir, fileName));
      return result?.durationSeconds ?? null;
    } catch {
      return null;
    }
  }));

  let remaining = totalDurationMs / 1000;
  return fileNames.map((fileName, index) => {
    const measured = probed[index];
    const durationSeconds = measured && measured > 0
      ? measured
      : Math.min(targetDurationSeconds, Math.max(0.001, remaining));
    remaining -= durationSeconds;
    return { fileName, durationSeconds, group: `ins:${insertId}`, seq: index };
  });
}

/**
 * Turns the eligible segment list into the playlist entries that should actually air, applying the
 * EDL. Each entry is `{ fileName, durationSeconds }`.
 *
 * A segment whose trim substitute cannot be produced is passed through whole rather than dropped.
 * That errs toward airing a few extra seconds of material the operator wanted gone, which is
 * recoverable, over dropping a segment that has content in it, which leaves a hole on air.
 */
async function applyEdlToSegments({
  segments,
  cuts,
  inserts = [],
  sessionDir,
  recordingStartedAtMs,
  targetDurationSeconds,
  ffmpegPath,
  width,
  height,
  frameRate,
  onTrimError,
  onInsertError,
}) {
  if (!cuts.length && !inserts.length) {
    return segments.map((segment) => ({
      fileName: segment.fileName,
      durationSeconds: targetDurationSeconds,
      group: LIVE_GROUP,
      seq: segment.index,
    }));
  }

  const merged = mergeRanges(cuts);
  // Each entry carries the span of live material it represents, so the splice below can find where
  // an insert's timecode falls. Inserted pieces have no span — they are not live material.
  const entries = [];

  for (const segment of segments) {
    const span = segmentSpan(segment.index, recordingStartedAtMs, targetDurationSeconds);
    const pieces = merged.length ? survivingPieces(span, merged) : [{ startMs: span.startMs, endMs: span.endMs }];

    // Entirely inside a cut.
    if (pieces.length === 0) continue;

    // Untouched by any cut — reference the recorder's own file, no re-encode.
    const untouched = pieces.length === 1
      && pieces[0].startMs <= span.startMs
      && pieces[0].endMs >= span.endMs;
    if (untouched) {
      entries.push({
        fileName: segment.fileName,
        durationSeconds: targetDurationSeconds,
        startMs: span.startMs,
        endMs: span.endMs,
        group: LIVE_GROUP,
        seq: segment.index,
      });
      continue;
    }

    for (const piece of pieces) {
      const offsetMs = piece.startMs - span.startMs;
      const durationMs = piece.endMs - piece.startMs;
      try {
        const fileName = await buildTrimmedSegment({
          ffmpegPath,
          sessionDir,
          segmentFileName: segment.fileName,
          offsetMs,
          durationMs,
        });
        entries.push({
          fileName,
          durationSeconds: durationMs / 1000,
          startMs: piece.startMs,
          endMs: piece.endMs,
          group: `trim:${fileName}`,
          seq: 0,
        });
      } catch (error) {
        onTrimError?.(segment.fileName, error);
        entries.push({
          fileName: segment.fileName,
          durationSeconds: targetDurationSeconds,
          startMs: span.startMs,
          endMs: span.endMs,
          group: LIVE_GROUP,
          seq: segment.index,
        });
        break;
      }
    }
  }

  if (!inserts.length) {
    return entries.map(({ fileName, durationSeconds, group, seq }) => ({ fileName, durationSeconds, group, seq }));
  }

  return spliceInserts({
    entries,
    inserts,
    sessionDir,
    targetDurationSeconds,
    ffmpegPath,
    width,
    height,
    frameRate,
    onInsertError,
  });
}

/**
 * Places each insert's transcoded pieces into the entry list at its timecode.
 *
 * The position is found by span rather than by index: an insert names a wall-clock instant, and the
 * entry list has already had cuts applied to it, so the Nth entry is not the Nth segment. Splicing
 * before the first entry that starts at or after the insert point puts the clip exactly where the
 * live would otherwise have continued.
 *
 * An insert whose material cannot be produced is skipped and the live left alone. That errs toward
 * airing the programme as though the insert had never been booked, which is recoverable, over
 * leaving a hole in the playlist, which is dead air.
 */
async function spliceInserts({
  entries,
  inserts,
  sessionDir,
  targetDurationSeconds,
  ffmpegPath,
  width,
  height,
  frameRate,
  onInsertError,
}) {
  // Latest first, so splicing one cannot move the position another has already been measured at.
  const ordered = [...inserts].sort((a, b) => b.atMs - a.atMs);
  const spliced = [...entries];

  for (const insert of ordered) {
    let pieces;
    try {
      pieces = await buildInsertSegments({
        ffmpegPath,
        sessionDir,
        insert,
        targetDurationSeconds,
        width,
        height,
        frameRate,
      });
    } catch (error) {
      onInsertError?.(insert, error);
      continue;
    }

    // The first entry that has not started before the insert point. Entries with no span are other
    // inserts, which hold their own place and must not be split apart by this one.
    let position = spliced.findIndex((entry) => Number.isFinite(entry.startMs) && entry.startMs >= insert.atMs);
    if (position === -1) position = spliced.length;

    spliced.splice(position, 0, ...pieces);
  }

  return spliced.map(({ fileName, durationSeconds, group, seq }) => ({ fileName, durationSeconds, group, seq }));
}

/**
 * Grace period before an unreferenced substitute is deleted. Covers the gap between a file being
 * finished and the next playlist rewrite picking it up, so a trim built moments ago is never
 * deleted out from under the playlist that is about to reference it.
 */
const TRIM_PRUNE_GRACE_MS = 120_000;

/**
 * Deletes trimmed substitutes the playlist no longer references.
 *
 * These files need their own cleanup because they deliberately do not match the recorder's
 * `emerald-tx-NNN.ts` naming — which is what keeps them out of the segment listings and out of the
 * playlist scan, but also means storageQuotaService's rolling trim (which matches that same
 * pattern) will never remove them. Left alone they would accumulate for the life of the session
 * while still counting toward the folder's size quota, making that quota progressively harder to
 * satisfy by deleting the segments it *can* delete.
 *
 * Best effort throughout: this runs inside the playlist write, and failing to delete a stale file
 * is not a reason to fail the write that keeps TX fed.
 */
async function pruneUnreferencedTrims(sessionDir, referencedFileNames) {
  try {
    const files = await fs.promises.readdir(sessionDir);
    const cutoff = Date.now() - TRIM_PRUNE_GRACE_MS;

    await Promise.all(
      files
        // Both kinds of generated media: trim substitutes and the pieces an inserted clip was
        // transcoded into. Neither matches emerald-tx-NNN.ts, which is what keeps them out of the
        // segment scans and equally out of the quota trimmer's reach, so this is their only cleanup.
        .filter((fileName) =>
          (fileName.startsWith(`${TRIM_PREFIX}-`) || fileName.startsWith(`${INSERT_PREFIX}-`))
          && fileName.endsWith(".ts"))
        .filter((fileName) => !referencedFileNames.has(fileName))
        .map(async (fileName) => {
          const filePath = path.join(sessionDir, fileName);
          try {
            const stat = await fs.promises.stat(filePath);
            if (stat.mtimeMs > cutoff) return;
            await fs.promises.unlink(filePath);

            // An insert's completion marker is meaningless once its pieces are gone, and leaving
            // it behind would make a later rebuild of the same clip believe the set already exists.
            if (fileName.startsWith(`${INSERT_PREFIX}-`)) {
              const marker = fileName.replace(/-\d+\.ts$/i, ".done");
              try { await fs.promises.unlink(path.join(sessionDir, marker)); } catch { /* already gone */ }
            }
          } catch {
            // Already gone, or held open — either way there is nothing useful to do here.
          }
        }),
    );
  } catch {
    // Unreadable directory is the playlist writer's problem to report, not this helper's.
  }
}

/**
 * Validates and records a cut.
 *
 * Every rejection here is a broadcast safety rule, not input tidiness — see the constants above
 * for why each one exists. Returns `{ ok: false, error }` rather than throwing so the route can
 * turn it into a 409 the operator can read and act on.
 */
function addCut(sessionDir, { startMs, endMs, recordingStartedAtMs, broadcastDelaySeconds, airPointMs, nowMs = Date.now() }) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { ok: false, error: "A cut needs a start and an end, with the end after the start." };
  }

  if (!(broadcastDelaySeconds > 0)) {
    return {
      ok: false,
      error: "This recording has no broadcast delay, so there is no window between capture and air to edit in. Start the recording with a delay to enable cutting to air.",
    };
  }

  const edl = loadEdl(sessionDir);
  const alreadyCutSeconds = totalCutSeconds(edl);

  // Where air has actually reached, in wall clock.
  //
  // Measured by the caller (server.js's onAirContentTime, from TX's own frame counter against the
  // playlist) and passed in, because that is the same figure the on-air marker is drawn at. It has
  // to be: this guard and that marker are the operator's two statements about where air is, and
  // when they disagree the panel refuses cuts on material the marker plainly shows as minutes away
  // from air. They diverged badly once TX began opening a session at its first completed segment —
  // air then sits however old the recording was behind live, while the estimate below assumes it
  // sits exactly one broadcast delay behind.
  //
  // The estimate survives only as a fallback for when the position cannot be derived (TX has sent
  // no frames yet, playlist unreadable). Charging all previous cuts against it is deliberately
  // pessimistic — it places air later than it may really be, so a marginal cut is refused rather
  // than raced, which is the right direction to be wrong in when guarding a live transmission. A
  // measured point needs no such correction: onAirContentTime already accounts for cuts it has
  // played past, so subtracting them again here would double-count them.
  // Deliberately not Number.isFinite: -Infinity is a meaningful value here, meaning "none of this
  // recording has gone out yet", and must not be mistaken for "no measurement supplied".
  const hasMeasuredAirPoint = typeof airPointMs === "number" && !Number.isNaN(airPointMs);
  const resolvedAirPointMs = hasMeasuredAirPoint
    ? airPointMs
    : nowMs - Math.max(0, broadcastDelaySeconds - alreadyCutSeconds) * 1000;

  if (startMs < resolvedAirPointMs + MIN_LEAD_SECONDS * 1000) {
    return {
      ok: false,
      error: `That range is already on air or too close to it. Cuts must start at least ${MIN_LEAD_SECONDS}s ahead of the air point.`,
    };
  }

  if (startMs < recordingStartedAtMs) {
    return { ok: false, error: "That range starts before this recording did." };
  }

  const cutSeconds = (endMs - startMs) / 1000;
  const remainingAfter = broadcastDelaySeconds - alreadyCutSeconds - cutSeconds;
  if (remainingAfter < MIN_REMAINING_DELAY_SECONDS) {
    return {
      ok: false,
      error: `Not enough delay left. This ${cutSeconds.toFixed(1)}s cut would leave ${Math.max(0, remainingAfter).toFixed(1)}s of runway; ${MIN_REMAINING_DELAY_SECONDS}s is the minimum before TX risks running out of playlist.`,
    };
  }

  const cut = {
    id: `cut-${Math.round(startMs)}-${Math.round(endMs)}`,
    startMs,
    endMs,
    createdAt: new Date(nowMs).toISOString(),
  };

  edl.cuts = mergeRanges([...edl.cuts, cut]).map((range) => ({
    id: `cut-${Math.round(range.startMs)}-${Math.round(range.endMs)}`,
    startMs: range.startMs,
    endMs: range.endMs,
    createdAt: new Date(nowMs).toISOString(),
  }));

  saveEdl(sessionDir, edl);
  return { ok: true, cut, edl, remainingDelaySeconds: remainingAfter };
}

/**
 * Books a clip into the transmission at a timecode.
 *
 * Two modes, which differ only in what happens to the live material underneath:
 *
 *   insert  — the live stops at `atMs`, the clip plays in full, and the live resumes from exactly
 *             where it stopped. Nothing is lost; the transmission simply runs the clip's length
 *             longer, so air falls that much further behind capture. It *buys* delay, the mirror of
 *             what a cut spends, and so can never starve the playlist.
 *
 *   overlay — the clip plays over the top for its own duration and the live keeps running
 *             underneath, so what was captured during that window never airs and the programme
 *             rejoins where it would have been anyway. Total duration is unchanged: the covered
 *             range is cut and the clip is spliced into the hole.
 *
 * The only guard either needs is lead time. Both leave the runway at least as long as they found
 * it, so MIN_REMAINING_DELAY_SECONDS — the rule that stops a cut spending the last of the delay —
 * has nothing to protect against here.
 */
function addInsert(sessionDir, {
  mode,
  atMs,
  sourcePath,
  durationMs,
  recordingStartedAtMs,
  broadcastDelaySeconds,
  airPointMs,
  nowMs = Date.now(),
}) {
  if (mode !== "insert" && mode !== "overlay") {
    return { ok: false, error: "Mode must be either 'insert' or 'overlay'." };
  }

  if (!Number.isFinite(atMs)) {
    return { ok: false, error: "A clip needs a timecode to play at." };
  }

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { ok: false, error: "Could not determine how long that clip runs." };
  }

  if (typeof sourcePath !== "string" || !sourcePath) {
    return { ok: false, error: "A clip needs a source file." };
  }

  if (!(broadcastDelaySeconds > 0)) {
    return {
      ok: false,
      error: "This recording has no broadcast delay, so there is no window between capture and air to place a clip in. Start the recording with a delay to enable this.",
    };
  }

  const edl = loadEdl(sessionDir);
  const alreadyCutSeconds = totalCutSeconds(edl);

  // Same air point, and the same reasoning, as addCut — see the comment there.
  const hasMeasuredAirPoint = typeof airPointMs === "number" && !Number.isNaN(airPointMs);
  const resolvedAirPointMs = hasMeasuredAirPoint
    ? airPointMs
    : nowMs - Math.max(0, broadcastDelaySeconds - alreadyCutSeconds) * 1000;

  if (atMs < resolvedAirPointMs + MIN_LEAD_SECONDS * 1000) {
    return {
      ok: false,
      error: `That timecode is already on air or too close to it. A clip must be placed at least ${MIN_LEAD_SECONDS}s ahead of the air point.`,
    };
  }

  if (atMs < recordingStartedAtMs) {
    return { ok: false, error: "That timecode is before this recording started." };
  }

  // Two clips fighting over the same instant would splice in an order neither operator chose.
  const clash = edl.inserts.find((existing) =>
    atMs < existing.atMs + existing.durationMs && existing.atMs < atMs + durationMs);
  if (clash) {
    return {
      ok: false,
      error: `That overlaps a clip already booked at ${new Date(clash.atMs).toLocaleTimeString()}. Remove it first, or choose a timecode after it ends.`,
    };
  }

  const insert = {
    id: `ins-${Math.round(atMs)}-${Math.round(durationMs)}`,
    mode,
    atMs,
    durationMs,
    sourcePath,
    name: path.basename(sourcePath),
    createdAt: new Date(nowMs).toISOString(),
  };

  edl.inserts = [...edl.inserts, insert].sort((a, b) => a.atMs - b.atMs);
  saveEdl(sessionDir, edl);
  return { ok: true, insert, edl };
}

/**
 * Cancels a booked clip, provided air has not reached it yet.
 *
 * The lead-time rule applies here exactly as it does to booking one: a clip whose pieces TX may
 * already have opened cannot be pulled back without a visible break in the transmission.
 */
function removeInsert(sessionDir, insertId, { broadcastDelaySeconds, airPointMs, nowMs = Date.now() }) {
  const edl = loadEdl(sessionDir);
  const insert = edl.inserts.find((entry) => entry.id === insertId);
  if (!insert) return { ok: false, error: "That clip is not booked." };

  const hasMeasuredAirPoint = typeof airPointMs === "number" && !Number.isNaN(airPointMs);
  const resolvedAirPointMs = hasMeasuredAirPoint
    ? airPointMs
    : nowMs - Math.max(0, broadcastDelaySeconds - totalCutSeconds(edl)) * 1000;

  if (insert.atMs < resolvedAirPointMs + MIN_LEAD_SECONDS * 1000) {
    return { ok: false, error: "That clip is already on air or too close to it to pull." };
  }

  edl.inserts = edl.inserts.filter((entry) => entry.id !== insertId);
  saveEdl(sessionDir, edl);
  return { ok: true, edl };
}

/**
 * Drops a cut, restoring that material to the playlist.
 *
 * Only possible while the range is still ahead of air — once the play point has passed where the
 * cut was, the shortened playlist has already gone out and putting the material back would air it
 * late and out of order.
 */
function removeCut(sessionDir, cutId, { broadcastDelaySeconds, nowMs = Date.now() }) {
  const edl = loadEdl(sessionDir);
  const cut = edl.cuts.find((entry) => entry.id === cutId);
  if (!cut) return { ok: false, error: "No such cut." };

  // The air point is computed from every cut EXCEPT this one. Counting a cut's own ripple against
  // itself makes it un-undoable the instant it is made: cutting 12s moves the estimated air point
  // 12s later, which lands past the very range just removed. The question being asked is "has the
  // play head reached where this cut begins", and this cut cannot have moved the play head past
  // its own start — only the cuts before it can.
  const otherCutsSeconds = totalCutSeconds({ cuts: edl.cuts.filter((entry) => entry.id !== cutId) });
  const remainingDelaySeconds = Math.max(0, broadcastDelaySeconds - otherCutsSeconds);
  const airPointMs = nowMs - remainingDelaySeconds * 1000;
  if (cut.startMs <= airPointMs) {
    return { ok: false, error: "That cut has already gone out — it can no longer be undone." };
  }

  edl.cuts = edl.cuts.filter((entry) => entry.id !== cutId);
  saveEdl(sessionDir, edl);
  return { ok: true, edl };
}

/** Everything the editor needs to know about the state of the editing window. */
function describeEdl(sessionDir, { broadcastDelaySeconds, nowMs = Date.now() }) {
  const edl = loadEdl(sessionDir);
  const spentSeconds = totalCutSeconds(edl);
  const remainingDelaySeconds = Math.max(0, (broadcastDelaySeconds || 0) - spentSeconds);

  return {
    cuts: edl.cuts,
    inserts: edl.inserts,
    spentSeconds,
    remainingDelaySeconds,
    minRemainingDelaySeconds: MIN_REMAINING_DELAY_SECONDS,
    minLeadSeconds: MIN_LEAD_SECONDS,
    /** Wall clock instant the transmission has reached, for the editor to place its air marker. */
    airPointMs: nowMs - remainingDelaySeconds * 1000,
  };
}

module.exports = {
  EDL_FILE_NAME,
  TRIM_PREFIX,
  LIVE_GROUP,
  MIN_REMAINING_DELAY_SECONDS,
  MIN_LEAD_SECONDS,
  loadEdl,
  saveEdl,
  pruneUnreferencedTrims,
  addCut,
  removeCut,
  addInsert,
  removeInsert,
  overlayCoveredRanges,
  INSERT_PREFIX,
  describeEdl,
  totalCutSeconds,
  mergeRanges,
  survivingPieces,
  segmentSpan,
  applyEdlToSegments,
};
