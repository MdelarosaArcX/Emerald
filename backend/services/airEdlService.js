const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

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
    return {
      cuts: cuts
        .filter((cut) => Number.isFinite(cut?.startMs) && Number.isFinite(cut?.endMs) && cut.endMs > cut.startMs)
        .sort((a, b) => a.startMs - b.startMs),
    };
  } catch {
    return { cuts: [] };
  }
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
  sessionDir,
  recordingStartedAtMs,
  targetDurationSeconds,
  ffmpegPath,
  onTrimError,
}) {
  if (!cuts.length) {
    return segments.map((segment) => ({ fileName: segment.fileName, durationSeconds: targetDurationSeconds }));
  }

  const merged = mergeRanges(cuts);
  const entries = [];

  for (const segment of segments) {
    const span = segmentSpan(segment.index, recordingStartedAtMs, targetDurationSeconds);
    const pieces = survivingPieces(span, merged);

    // Entirely inside a cut.
    if (pieces.length === 0) continue;

    // Untouched by any cut — reference the recorder's own file, no re-encode.
    const untouched = pieces.length === 1
      && pieces[0].startMs <= span.startMs
      && pieces[0].endMs >= span.endMs;
    if (untouched) {
      entries.push({ fileName: segment.fileName, durationSeconds: targetDurationSeconds });
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
        entries.push({ fileName, durationSeconds: durationMs / 1000 });
      } catch (error) {
        onTrimError?.(segment.fileName, error);
        entries.push({ fileName: segment.fileName, durationSeconds: targetDurationSeconds });
        break;
      }
    }
  }

  return entries;
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
        .filter((fileName) => fileName.startsWith(`${TRIM_PREFIX}-`) && fileName.endsWith(".ts"))
        .filter((fileName) => !referencedFileNames.has(fileName))
        .map(async (fileName) => {
          const filePath = path.join(sessionDir, fileName);
          try {
            const stat = await fs.promises.stat(filePath);
            if (stat.mtimeMs > cutoff) return;
            await fs.promises.unlink(filePath);
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
function addCut(sessionDir, { startMs, endMs, recordingStartedAtMs, broadcastDelaySeconds, nowMs = Date.now() }) {
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

  // Where air has reached, in wall clock. The delay is the design gap between now and air, and
  // every second already cut brings air that much closer to the present once TX plays through it.
  //
  // Charging all previous cuts immediately is deliberately pessimistic — it places air later than
  // it may actually be yet, so a marginal cut is refused rather than raced. For a guard protecting
  // a live transmission that is the correct direction to be wrong in.
  const airPointMs = nowMs - Math.max(0, broadcastDelaySeconds - alreadyCutSeconds) * 1000;

  if (startMs < airPointMs + MIN_LEAD_SECONDS * 1000) {
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
  MIN_REMAINING_DELAY_SECONDS,
  MIN_LEAD_SECONDS,
  loadEdl,
  saveEdl,
  pruneUnreferencedTrims,
  addCut,
  removeCut,
  describeEdl,
  totalCutSeconds,
  mergeRanges,
  survivingPieces,
  segmentSpan,
  applyEdlToSegments,
};
