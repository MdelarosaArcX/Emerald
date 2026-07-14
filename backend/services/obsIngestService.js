const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { normalizeFfmpegPath } = require("./obsRecordingService");
const { isUdpInputUrl, normalizeInputUrl } = require("./ffmpegInputUrl");
const { parseSizeLimit, getDirectorySize, enforceFolderQuota, trimActiveSessionSegments } = require("./storageQuotaService");
const { logEvent } = require("./eventLogService");

const MAINTENANCE_INTERVAL_MS = 5000;

// Ffmpeg's own hls muxer output (emerald-tx.m3u8, written by the third recording output below)
// updates itself by writing a temp file and renaming it over the target. On Windows, that
// rename fails silently once another process (the TX decoder) has the file open for reading,
// so ffmpeg's own playlist gets stuck after its first update and TX never advances past segment
// 0. Node owns this second copy instead: it rewrites the file in place (open+truncate+write, no
// rename) on every maintenance tick, which a concurrent reader picks up fine on Windows.
const TX_LIVE_PLAYLIST_NAME = "emerald-tx-live.m3u8";

// Deliberately independent of the archival segment_time (the 2-minute .mov/.mp4 clip length): the
// HLS muxer doesn't create/write its current .ts file on disk until that segment closes (verified
// empirically — with hls_time equal to the 2-minute archival duration, emerald-tx-000.ts didn't
// exist at all until t=120s, the exact same instant as emerald-001.mov/mp4 appearing). Combined
// with our own "only list *finished* segments" rule in writeTxPlaylist(), that meant nothing was
// ever playable on TX until a full *2* archival segments had elapsed, not 1. Short HLS segments
// (standard practice for live HLS) make the first .ts appear within a few seconds instead.
const TX_HLS_SEGMENT_SECONDS = 4;

class ObsIngestService {
  constructor(recordingsPath) {
    this.recordingsPath = recordingsPath;
    this.process = null;
    this.recordingStatus = {
      isRecording: false,
      startedAt: null,
      inputUrl: null,
      outputPattern: null,
      segmentSeconds: 120,
      container: "mp4",
      backupPath: null,
      backupAvailable: false,
      lastMessage: null,
    };
    this.maintenanceHandle = null;
    this.sessionFolderName = null;
    this.backupDir = null;
    this.copiedBackupSegments = new Set();
    // Tracks whether the underlying FFmpeg OS process has actually exited — distinct from
    // `this.process` being nulled, which can happen before the process finishes flushing its
    // last segment during graceful shutdown (stdin "q" + up to 5s grace period).
    this.ffmpegExited = true;
  }

  async start(request) {
    if (!request.inputUrl || !String(request.inputUrl).trim()) {
      throw new Error("Recording URL is required.");
    }

    if (this.isProcessRunning()) {
      return { recordingStatus: this.recordingStatus };
    }

    const segmentSeconds = clamp(Number(request.segmentSeconds || 120), 10, 3600);
    // Deliberate gap between "captured" and "eligible to go on air" — e.g. so a producer has a
    // window to catch and cut something before it airs. 0 disables it (segments go live as soon
    // as they're finished, the previous behavior). Independent of segmentSeconds/the 2-minute
    // archival clip length — this only affects what's listed in emerald-tx-live.m3u8, so TX and
    // the Playback Deck stay ~this far behind the actual live capture at all times.
    const broadcastDelaySeconds = clamp(Number(request.broadcastDelaySeconds ?? 0), 0, 3600);
    const ffmpegPath = normalizeFfmpegPath(request.ffmpegPath);
    const inputUrl = normalizeInputUrl(request.inputUrl);
    // One folder per recording session, named after the local time the session started.
    // Segment index (%03d) is driven by the shared input's PTS boundaries, so it stays
    // identical across both outputs even though ProRes encoding and H.264 stream-copy run
    // at different real-time speeds — using "-strftime 1" per output instead would let
    // their filenames drift apart over time.
    const sessionFolderName = createSessionFolder(this.recordingsPath, new Date());
    const sessionDir = path.join(this.recordingsPath, sessionFolderName);
    const archivalOutputPattern = path.join(sessionDir, "emerald-%03d.mov");
    const outputPattern = path.join(sessionDir, "emerald-%03d.mp4");
    const txPlaylistPath = path.join(sessionDir, "emerald-tx.m3u8");
    const txSegmentPattern = path.join(sessionDir, "emerald-tx-%03d.ts");
    const { backupDir, backupPath } = resolveBackupDir();
    const recordingSizeLimitBytes = parseSizeLimit(process.env.RECORDING_SIZE_LIMIT);
    const storageSizeLimitBytes = parseSizeLimit(process.env.STORAGE_SIZE_LIMIT);

    // Every recording writes three synchronized outputs from the same input in one ffmpeg
    // process: a ProRes 422 MOV for archival (hidden from Media Browser), a stream-copied
    // H.264 MP4 for playout (the one shown/played in Media Browser), and an HLS (.ts segments
    // + a live-updating .m3u8) rendition purely for Push On Air. The HLS muxer only appends a
    // segment to the playlist once that segment is actually finished, and only writes
    // #EXT-X-ENDLIST once ffmpeg exits cleanly — so while recording is still active, ffmpeg's
    // own "hls" demuxer can follow this playlist directly and it will naturally wait at the
    // live edge for the next segment instead of us having to poll the filesystem (see
    // DeltacastTxService.cs / server.js's /api/tx/start live-session branch).
    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      ...buildUdpInputArgs(inputUrl),
      "-i", inputUrl,

      // Audio (once the Deltacast pipeline has it — CaptureOptions.EnableAudio on the C# side,
      // still off by default) rides in as an AAC track on this same input, so it's re-encoded
      // to AAC here rather than passed through — ProRes archival wants a real codec choice, not
      // whatever the delivery-side bitrate happens to be. "?" makes the map optional so this
      // stays a harmless no-op (exactly today's video-only behavior) until audio actually exists
      // upstream.
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le",
      "-c:a", "aac", "-b:a", "192k",
      "-f", "segment",
      "-segment_time", String(segmentSeconds),
      "-reset_timestamps", "1",
      "-segment_start_number", "0",
      "-segment_format", "mov",
      archivalOutputPattern,

      // "-map 0" + "-c copy" already carries audio through automatically once the input has an
      // AAC track — no change needed here for that; today it's a harmless no-op specifically
      // because the input never has one yet.
      "-map", "0",
      "-c", "copy",
      "-f", "segment",
      "-segment_time", String(segmentSeconds),
      "-reset_timestamps", "1",
      "-segment_start_number", "0",
      "-segment_format", "mp4",
      outputPattern,

      "-map", "0",
      "-c", "copy",
      "-f", "hls",
      "-hls_time", String(TX_HLS_SEGMENT_SECONDS),
      "-hls_list_size", "0",
      // "event" tells players (hls.js, Safari) this playlist only ever grows — segments are
      // never removed — so they can safely start at position 0 and keep extending playback as
      // new segments land, instead of defaulting to a live-edge sliding window.
      "-hls_playlist_type", "event",
      "-hls_flags", "independent_segments+append_list",
      "-hls_segment_filename", txSegmentPattern,
      txPlaylistPath,
    ];

    try {
      this.process = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.process = null;
      this.recordingStatus = { ...this.recordingStatus, isRecording: false, lastMessage: error.message };
      throw new Error(`Unable to start FFmpeg at '${ffmpegPath}'. Use the full path to ffmpeg.exe or a folder that contains ffmpeg.exe.`);
    }

    const startedProcess = this.process;

    startedProcess.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.recordingStatus = { ...this.recordingStatus, lastMessage: message };
      }
    });

    this.ffmpegExited = false;

    startedProcess.on("error", (error) => {
      this.recordingStatus = { ...this.recordingStatus, isRecording: false, startedAt: null, lastMessage: error.message };
      if (this.process === startedProcess) {
        this.process = null;
      }
      this.ffmpegExited = true;
      this.stopMaintenance({ finalSync: true });
    });

    startedProcess.on("exit", () => {
      const detail = explainFfmpegMessage(this.recordingStatus.lastMessage || "FFmpeg stopped.", inputUrl);
      this.recordingStatus = { ...this.recordingStatus, isRecording: false, lastMessage: detail };
      this.process = null;
      this.ffmpegExited = true;
      this.stopMaintenance({ finalSync: true });
    });

    this.recordingStatus = {
      isRecording: true,
      startedAt: new Date().toISOString(),
      inputUrl,
      outputPattern,
      archivalOutputPattern,
      txPlaylistPath,
      segmentSeconds,
      broadcastDelaySeconds,
      container: "mp4",
      backupPath,
      backupAvailable: Boolean(backupDir),
      lastMessage: backupDir ? null : `Backup drive '${backupPath}' is not available — recording locally only.`,
    };

    this.sessionFolderName = sessionFolderName;
    this.recordingSizeLimitBytes = recordingSizeLimitBytes;
    this.storageSizeLimitBytes = storageSizeLimitBytes;
    this.broadcastDelaySeconds = broadcastDelaySeconds;
    this.copiedBackupSegments = new Set();

    if (backupDir) {
      this.backupDir = backupDir;
    }

    // Quota enforcement always runs (it needs no backup drive); backup mirroring inside
    // the tick is skipped when backupDir isn't set.
    enforceFolderQuota(this.recordingsPath, this.recordingSizeLimitBytes, this.sessionFolderName);
    this.maintenanceHandle = setInterval(() => this.runMaintenance(), MAINTENANCE_INTERVAL_MS);
    this.maintenanceHandle.unref?.();

    await waitForFfmpegStartup(startedProcess, ffmpegPath, () => this.recordingStatus.lastMessage, inputUrl);

    logEvent(`Recording started — folder=${sessionFolderName}, segmentSeconds=${segmentSeconds}, broadcastDelaySeconds=${broadcastDelaySeconds}`);

    return { recordingStatus: this.recordingStatus };
  }

  stop() {
    if (!this.process) {
      this.recordingStatus = { ...this.recordingStatus, isRecording: false };
      return { recordingStatus: this.recordingStatus };
    }

    const processToStop = this.process;

    if (!processToStop.killed) {
      try {
        processToStop.stdin.write("q\n");
      } catch {
        // Fall back to terminating below.
      }

      setTimeout(() => {
        if (this.process === processToStop && !processToStop.killed) {
          processToStop.kill("SIGKILL");
        }
      }, 5000).unref();
    }

    // this.process is cleared here for UI/API purposes (recordingStatus.isRecording), but the
    // backup sync keys off this.ffmpegExited instead — the OS process may still be flushing its
    // last segment during graceful shutdown, and the "exit" handler above finalizes the backup
    // copy only once it has actually terminated.
    this.process = null;
    this.recordingStatus = { ...this.recordingStatus, isRecording: false, lastMessage: "Recording stopped." };
    return { recordingStatus: this.recordingStatus };
  }

  isProcessRunning() {
    return Boolean(this.process && !this.process.killed && this.process.exitCode === null && this.process.signalCode === null);
  }

  // Runs on every maintenance tick while a session is active (and once more on final
  // shutdown): mirrors finished segments to the backup drive, then enforces both size
  // quotas so overflow is trimmed continuously instead of only at session boundaries.
  async runMaintenance() {
    await this.updateLiveTxPlaylist();

    if (this.backupDir) {
      await this.syncBackupSegments();
    }

    await enforceFolderQuota(this.recordingsPath, this.recordingSizeLimitBytes, this.sessionFolderName);

    // Evicting other, finished sessions above may not be enough — a single long recording can
    // exceed the whole-folder limit entirely on its own, with no other sessions left to delete.
    // Recording must never stop to enforce the quota, so once nothing else is left to evict, fall
    // back to trimming the active session's own oldest *finished* segments (never the one FFmpeg
    // is still writing) until the folder is back under the limit.
    if (this.recordingSizeLimitBytes && this.sessionFolderName) {
      const totalBytes = await getDirectorySize(this.recordingsPath);

      if (totalBytes > this.recordingSizeLimitBytes) {
        const sessionDir = path.join(this.recordingsPath, this.sessionFolderName);
        await trimActiveSessionSegments(sessionDir, this.recordingSizeLimitBytes, totalBytes);
        // Re-sync immediately so the TX playlist never references a just-deleted .ts segment in
        // the window before the next maintenance tick.
        await this.updateLiveTxPlaylist();
      }
    }

    if (this.backupDir) {
      await enforceFolderQuota(this.backupDir, this.storageSizeLimitBytes, this.sessionFolderName);

      // Same gap as RECORDING_SIZE_LIMIT above, same fix: evicting other finished sessions'
      // backup copies alone isn't enough once a single long recording's own mirrored ProRes
      // segments exceed the backup drive's limit by themselves. Trim its oldest already-copied
      // (and, per syncBackupSegments, already-finished) segments instead of ever pausing the
      // backup sync or the recording itself.
      if (this.storageSizeLimitBytes && this.sessionFolderName) {
        const backupTotalBytes = await getDirectorySize(this.backupDir);

        if (backupTotalBytes > this.storageSizeLimitBytes) {
          const backupSessionDir = path.join(this.backupDir, this.sessionFolderName);
          await trimActiveSessionSegments(backupSessionDir, this.storageSizeLimitBytes, backupTotalBytes);
        }
      }
    }
  }

  // Rewrites emerald-tx-live.m3u8 from whatever emerald-tx-NNN.ts segments exist on disk. See
  // the comment on TX_LIVE_PLAYLIST_NAME for why this exists instead of just using ffmpeg's own
  // hls muxer output directly.
  async updateLiveTxPlaylist() {
    if (!this.sessionFolderName) return;

    const sessionDir = path.join(this.recordingsPath, this.sessionFolderName);

    try {
      await writeTxPlaylist(sessionDir, TX_HLS_SEGMENT_SECONDS, this.ffmpegExited, this.broadcastDelaySeconds || 0);
    } catch (error) {
      this.recordingStatus = { ...this.recordingStatus, lastMessage: `Unable to update TX playlist: ${error.message}` };
    }
  }

  // Mirrors completed ProRes 422 segments to the backup drive, preserving the same
  // per-session folder layout as the recordings drive. Runs on a poll instead of fs.watch
  // since the backup target is often a removable drive that can be unmounted mid-recording.
  async syncBackupSegments() {
    if (!this.backupDir || !this.sessionFolderName) return;

    const sessionDir = path.join(this.recordingsPath, this.sessionFolderName);
    let files;
    try {
      files = await fs.promises.readdir(sessionDir);
    } catch {
      return;
    }

    const pattern = /^emerald-(\d+)\.mov$/;
    const segments = files
      .map((fileName) => {
        const match = pattern.exec(fileName);
        return match ? { fileName, index: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);

    // The last (highest-index) segment is still being written by FFmpeg — only mirror finished ones.
    const finishedSegments = this.ffmpegExited ? segments : segments.slice(0, -1);

    if (finishedSegments.length === 0) return;

    const backupSessionDir = path.join(this.backupDir, this.sessionFolderName);
    try {
      await fs.promises.mkdir(backupSessionDir, { recursive: true });
    } catch (error) {
      this.recordingStatus = { ...this.recordingStatus, lastMessage: `Unable to create backup folder: ${error.message}` };
      return;
    }

    for (const segment of finishedSegments) {
      if (this.copiedBackupSegments.has(segment.fileName)) continue;

      try {
        await fs.promises.copyFile(
          path.join(sessionDir, segment.fileName),
          path.join(backupSessionDir, segment.fileName),
        );
        this.copiedBackupSegments.add(segment.fileName);
      } catch (error) {
        this.recordingStatus = { ...this.recordingStatus, lastMessage: `Backup copy failed for '${segment.fileName}': ${error.message}` };
      }
    }
  }

  stopMaintenance({ finalSync = false } = {}) {
    if (this.maintenanceHandle) {
      clearInterval(this.maintenanceHandle);
      this.maintenanceHandle = null;
    }

    if (finalSync) {
      this.runMaintenance().finally(() => {
        this.backupDir = null;
      });
    }
  }
}

module.exports = {
  ObsIngestService,
  TX_LIVE_PLAYLIST_NAME,
  startOrphanTxPlaylistWatcher,
};

// Builds emerald-tx-live.m3u8's content from whatever emerald-tx-NNN.ts segments exist in
// `sessionDir`, then writes it in place (no rename — see the comment on TX_LIVE_PLAYLIST_NAME).
// Returns false if there are no eligible segments to write yet.
async function writeTxPlaylist(sessionDir, targetDuration, ffmpegExited, delaySeconds = 0) {
  const files = await fs.promises.readdir(sessionDir);

  const pattern = /^emerald-tx-(\d+)\.ts$/;
  const segments = files
    .map((fileName) => {
      const match = pattern.exec(fileName);
      return match ? { fileName, index: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);

  // Ffmpeg's hls muxer doesn't finalize a .ts segment until it rotates to the next one —
  // the same rule already applied to the mov/mp4 outputs in syncBackupSegments.
  const finishedSegments = ffmpegExited ? segments : segments.slice(0, -1);
  if (finishedSegments.length === 0) return false;

  // Broadcast delay: while still actively recording, hold each segment out of the live playlist
  // until it's at least `delaySeconds` old (by file mtime, so this is robust to any timing
  // irregularities rather than assuming exactly targetDuration per segment) — a deliberate,
  // rolling gap between "captured" and "eligible to air", e.g. so a producer has a window to
  // catch and cut something before it goes out. Once recording stops there's nothing left to
  // review, so release everything immediately instead of trickling out the last delaySeconds'
  // worth after the operator has already stopped.
  let eligibleSegments = finishedSegments;
  if (delaySeconds > 0 && !ffmpegExited) {
    const cutoffMs = Date.now() - delaySeconds * 1000;
    const withMtimes = await Promise.all(finishedSegments.map(async (segment) => {
      try {
        const stat = await fs.promises.stat(path.join(sessionDir, segment.fileName));
        return { ...segment, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }));
    eligibleSegments = withMtimes.filter((segment) => segment && segment.mtimeMs <= cutoffMs);
  }

  if (eligibleSegments.length === 0) return false;

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    // The storage quota's rolling-buffer trim (trimActiveSessionSegments) can delete the earliest
    // .ts segments out from under a still-recording session, so the first listed segment's index
    // is no longer reliably 0 — MEDIA-SEQUENCE must track whatever segment is actually first here,
    // per the HLS spec, or players/ffmpeg's hls demuxer will mis-map segment numbering.
    `#EXT-X-MEDIA-SEQUENCE:${eligibleSegments[0].index}`,
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    ...eligibleSegments.flatMap((segment) => [`#EXTINF:${targetDuration.toFixed(6)},`, segment.fileName]),
  ];

  if (ffmpegExited) {
    lines.push("#EXT-X-ENDLIST");
  }

  await fs.promises.writeFile(path.join(sessionDir, TX_LIVE_PLAYLIST_NAME), lines.join("\n") + "\n", "utf8");
  return true;
}

// A session's emerald-tx-live.m3u8 only gets kept in sync with its .ts segments (and eventually
// gets its #EXT-X-ENDLIST) while an ObsIngestService instance owns it — see
// updateLiveTxPlaylist(). If the backend restarts or crashes mid-recording, the underlying
// ffmpeg process can be left running as an orphan (still writing new segments) with nobody
// updating its playlist, or the recording can simply have ended with the file never finalized.
// Either way, both the browser preview (hls.js) and the hardware TX decoder (DeltacastCaptureService,
// which reads this exact file straight off disk) are left waiting forever for a playlist update
// that will never come from the process that used to send it.
//
// This runs continuously (not just once at startup) and is intentionally ownership-agnostic: for
// every session folder `isOwnedActiveSession` says isn't the current in-process recording, it
// rewrites the live playlist from whatever .ts segments actually exist on disk, using the newest
// segment's mtime — not process identity — to decide whether the session is still growing (keep
// following it, no ENDLIST) or has gone idle long enough to be considered finished (finalize with
// ENDLIST). A one-shot startup-only check would miss the case where the orphaned recording is
// still actively producing new segments after the crash/restart.
const ORPHAN_PLAYLIST_STALE_MS = 15 * 60 * 1000;

function startOrphanTxPlaylistWatcher(recordingsPath, isOwnedActiveSession) {
  const run = () => reconcileUnownedTxPlaylists(recordingsPath, isOwnedActiveSession).catch(() => {});

  run();
  const handle = setInterval(run, MAINTENANCE_INTERVAL_MS);
  handle.unref?.();
  return handle;
}

async function reconcileUnownedTxPlaylists(recordingsPath, isOwnedActiveSession) {
  let entries;
  try {
    entries = await fs.promises.readdir(recordingsPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || isOwnedActiveSession(entry.name)) continue;

    const sessionDir = path.join(recordingsPath, entry.name);
    let files;
    try {
      files = await fs.promises.readdir(sessionDir);
    } catch {
      continue;
    }

    const pattern = /^emerald-tx-(\d+)\.ts$/;
    const segments = files
      .map((fileName) => {
        const match = pattern.exec(fileName);
        return match ? { fileName, index: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);

    if (segments.length === 0) continue;

    let newestMtimeMs;
    try {
      newestMtimeMs = (await fs.promises.stat(path.join(sessionDir, segments[segments.length - 1].fileName))).mtimeMs;
    } catch {
      continue;
    }

    const ffmpegExited = Date.now() - newestMtimeMs > ORPHAN_PLAYLIST_STALE_MS;

    if (ffmpegExited) {
      // Don't keep rewriting an already-finalized playlist on every tick once it's done.
      try {
        const existing = await fs.promises.readFile(path.join(sessionDir, TX_LIVE_PLAYLIST_NAME), "utf8");
        if (existing.includes("#EXT-X-ENDLIST")) continue;
      } catch {
        // No playlist yet — fall through and write the finalized one below.
      }
    }

    await writeTxPlaylist(sessionDir, TX_HLS_SEGMENT_SECONDS, ffmpegExited).catch(() => {});
  }
}

// Backup path is a backend-only setting (EMERALD_BACKUP_PATH in backend/.env) — it is never
// accepted from the frontend request body.
function resolveBackupDir() {
  const backupPath = String(process.env.EMERALD_BACKUP_PATH || "E:\\").trim();

  try {
    // fs.mkdirSync throws EPERM on a drive root (e.g. "E:\") even with recursive:true,
    // since the root always exists and can't be "created" — only mkdir when it's missing.
    if (!fs.existsSync(backupPath)) {
      fs.mkdirSync(backupPath, { recursive: true });
    }
    fs.accessSync(backupPath, fs.constants.W_OK);
    return { backupDir: backupPath, backupPath };
  } catch {
    // Backup drive not present/writable (e.g. removable drive unplugged) — record locally only.
    return { backupDir: null, backupPath };
  }
}

// Folder name is "emerald" + local time as MMDDYYYYHHmm (e.g. 4:31 AM on 2026-03-07 ->
// "emerald030720260431"). Local time, not UTC, since it's meant to read as a wall-clock
// timestamp for whoever is browsing the recordings folder.
function formatSessionFolderName(date) {
  const pad = (value, length = 2) => String(value).padStart(length, "0");

  return `emerald${pad(date.getMonth() + 1)}${pad(date.getDate())}${date.getFullYear()}`
    + `${pad(date.getHours())}${pad(date.getMinutes())}`;
}

// Same-minute restarts would otherwise collide on one folder name — suffix with -2, -3, ...
function createSessionFolder(recordingsPath, date) {
  const baseName = formatSessionFolderName(date);
  let folderName = baseName;
  let suffix = 2;

  while (fs.existsSync(path.join(recordingsPath, folderName))) {
    folderName = `${baseName}-${suffix}`;
    suffix += 1;
  }

  fs.mkdirSync(path.join(recordingsPath, folderName), { recursive: true });
  return folderName;
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function waitForFfmpegStartup(process, ffmpegPath, getLastMessage, inputUrl) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      process.off("error", onError);
      process.off("exit", onExit);
    };

    const fail = (message) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error(message));
    };

    const onError = (error) => {
      fail(formatFfmpegStartError(ffmpegPath, error));
    };

    const onExit = (code, signal) => {
      const detail = explainFfmpegMessage(getLastMessage?.(), inputUrl);
      fail(`FFmpeg stopped before it could start${formatExit(code, signal)}.${detail ? ` ${detail}` : " Check the FFmpeg path and stream URL."}`);
    };

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    }, 750);

    process.once("error", onError);
    process.once("exit", onExit);
  });
}

function formatFfmpegStartError(ffmpegPath, error) {
  if (error?.code === "ENOENT") {
    return `Unable to start FFmpeg at '${ffmpegPath}'. FFmpeg was not found. Install FFmpeg and add it to PATH, set FFMPEG_PATH in backend/.env, or paste the full path to ffmpeg.exe in the FFmpeg Path field.`;
  }

  return `Unable to start FFmpeg at '${ffmpegPath}'. ${error?.message || "Check the FFmpeg path."}`;
}

function formatExit(code, signal) {
  const parts = [];

  if (code !== null) {
    const signedCode = code > 2147483647 ? code - 4294967296 : code;
    parts.push(`exit code ${signedCode}${signedCode !== code ? ` (${code})` : ""}`);
  }

  if (signal) {
    parts.push(signal);
  }

  return parts.length ? ` (${parts.join(", ")})` : "";
}

function explainFfmpegMessage(message, inputUrl) {
  if (message && message.toLowerCase().includes("error opening input")) {
    if (String(inputUrl || "").trim().toLowerCase().startsWith("udp://")) {
      return `${message} For a local UDP ingest from Deltacast, use udp://0.0.0.0:5000 or udp://@:5000 so FFmpeg listens on the port. Do not use udp://127.0.0.1:5000 unless another process is sending unicast UDP to that exact address.`;
    }

    return `${message} Check that the stream is streaming to rtmp://127.0.0.1:1935/live with stream key emerald, then start recording again.`;
  }

  if (message && /non-existing PPS|decode_slice_header error|no frame!/i.test(message)) {
    if (String(inputUrl || "").trim().toLowerCase().startsWith("udp://")) {
      return `${message} The UDP sender is likely not repeating H.264 SPS/PPS often enough. In your C# Deltacast encoder, make sure SPS/PPS are inserted at the start of the stream and repeated on each keyframe.`;
    }
  }

  return message;
}

function buildUdpInputArgs(inputUrl) {
  if (!isUdpInputUrl(inputUrl)) {
    return [];
  }

  // Declare MPEG-TS so FFmpeg skips format probing — the C# Deltacast bridge
  // always outputs H.264 MPEG-TS, so probing adds latency with no benefit.
  return [
    "-f", "mpegts",
    "-fflags", "+discardcorrupt",
    "-max_delay", "200000",
  ];
}
