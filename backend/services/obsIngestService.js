const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { normalizeFfmpegPath } = require("./obsRecordingService");
const { isUdpInputUrl, normalizeInputUrl } = require("./ffmpegInputUrl");

const BACKUP_SYNC_INTERVAL_MS = 5000;

class ObsIngestService {
  constructor(recordingsPath) {
    this.recordingsPath = recordingsPath;
    this.process = null;
    this.recordingStatus = {
      isRecording: false,
      startedAt: null,
      inputUrl: null,
      outputPattern: null,
      segmentSeconds: 300,
      container: "mp4",
      backupPath: null,
      backupAvailable: false,
      lastMessage: null,
    };
    this.backupSyncHandle = null;
    this.backupSessionStamp = null;
    this.backupDir = null;
    this.copiedBackupSegments = new Set();
    // Tracks whether the underlying FFmpeg OS process has actually exited — distinct from
    // `this.process` being nulled, which can happen before the process finishes flushing its
    // last segment during graceful shutdown (stdin "q" + up to 5s grace period).
    this.ffmpegExited = true;
  }

  async start(request) {
    if (!request.inputUrl || !String(request.inputUrl).trim()) {
      throw new Error("OBS recording URL is required.");
    }

    if (this.isProcessRunning()) {
      return { recordingStatus: this.recordingStatus };
    }

    const segmentSeconds = clamp(Number(request.segmentSeconds || 300), 10, 3600);
    const ffmpegPath = normalizeFfmpegPath(request.ffmpegPath);
    const inputUrl = normalizeInputUrl(request.inputUrl);
    // Generated once per recording session, not per segment file. Segment index (%03d) is
    // driven by the shared input's PTS boundaries, so it stays identical across both outputs
    // even though ProRes encoding and H.264 stream-copy run at different real-time speeds —
    // using "-strftime 1" per output instead would let their filenames drift apart over time.
    const sessionStamp = formatUtcSessionTimestamp(new Date());
    const archivalFileName = `obs-${sessionStamp}-%03d.mov`;
    const archivalOutputPattern = path.join(this.recordingsPath, archivalFileName);
    const outputPattern = path.join(this.recordingsPath, `obs-${sessionStamp}-%03d.mp4`);
    const { backupDir, backupPath } = resolveBackupDir(request.backupPath);

    // Every recording writes two synchronized outputs from the same input in one
    // ffmpeg process: a ProRes 422 MOV for archival (hidden from Media Browser)
    // and a stream-copied H.264 MP4 for playout (the one shown/played in Media Browser).
    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      ...buildUdpInputArgs(inputUrl),
      "-i", inputUrl,

      "-map", "0:v:0",
      "-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le",
      "-f", "segment",
      "-segment_time", String(segmentSeconds),
      "-reset_timestamps", "1",
      "-segment_start_number", "0",
      "-segment_format", "mov",
      archivalOutputPattern,

      "-map", "0",
      "-c", "copy",
      "-f", "segment",
      "-segment_time", String(segmentSeconds),
      "-reset_timestamps", "1",
      "-segment_start_number", "0",
      "-segment_format", "mp4",
      outputPattern,
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
      this.stopBackupSync({ finalSync: true });
    });

    startedProcess.on("exit", () => {
      const detail = explainFfmpegMessage(this.recordingStatus.lastMessage || "FFmpeg stopped.", inputUrl);
      this.recordingStatus = { ...this.recordingStatus, isRecording: false, lastMessage: detail };
      this.process = null;
      this.ffmpegExited = true;
      this.stopBackupSync({ finalSync: true });
    });

    this.recordingStatus = {
      isRecording: true,
      startedAt: new Date().toISOString(),
      inputUrl,
      outputPattern,
      archivalOutputPattern,
      segmentSeconds,
      container: "mp4",
      backupPath,
      backupAvailable: Boolean(backupDir),
      lastMessage: backupDir ? null : `Backup drive '${backupPath}' is not available — recording locally only.`,
    };

    if (backupDir) {
      this.backupSessionStamp = sessionStamp;
      this.backupDir = backupDir;
      this.copiedBackupSegments = new Set();
      this.backupSyncHandle = setInterval(() => this.syncBackupSegments(), BACKUP_SYNC_INTERVAL_MS);
      this.backupSyncHandle.unref?.();
    }

    await waitForFfmpegStartup(startedProcess, ffmpegPath, () => this.recordingStatus.lastMessage, inputUrl);

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

  // Mirrors completed ProRes 422 segments to the backup drive. Runs on a poll instead of
  // fs.watch since the backup target is often a removable drive that can be unmounted mid-recording.
  async syncBackupSegments() {
    if (!this.backupDir || !this.backupSessionStamp) return;

    let files;
    try {
      files = await fs.promises.readdir(this.recordingsPath);
    } catch {
      return;
    }

    const pattern = new RegExp(`^obs-${this.backupSessionStamp}-(\\d+)\\.mov$`);
    const segments = files
      .map((fileName) => {
        const match = pattern.exec(fileName);
        return match ? { fileName, index: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);

    // The last (highest-index) segment is still being written by FFmpeg — only mirror finished ones.
    const finishedSegments = this.ffmpegExited ? segments : segments.slice(0, -1);

    for (const segment of finishedSegments) {
      if (this.copiedBackupSegments.has(segment.fileName)) continue;

      try {
        await fs.promises.copyFile(
          path.join(this.recordingsPath, segment.fileName),
          path.join(this.backupDir, segment.fileName),
        );
        this.copiedBackupSegments.add(segment.fileName);
      } catch (error) {
        this.recordingStatus = { ...this.recordingStatus, lastMessage: `Backup copy failed for '${segment.fileName}': ${error.message}` };
      }
    }
  }

  stopBackupSync({ finalSync = false } = {}) {
    if (this.backupSyncHandle) {
      clearInterval(this.backupSyncHandle);
      this.backupSyncHandle = null;
    }

    if (finalSync && this.backupDir) {
      this.syncBackupSegments().finally(() => {
        this.backupDir = null;
        this.backupSessionStamp = null;
      });
    }
  }
}

module.exports = {
  ObsIngestService,
};

function resolveBackupDir(requestedBackupPath) {
  const backupPath = String((requestedBackupPath && String(requestedBackupPath).trim()) || process.env.EMERALD_BACKUP_PATH || "E:\\").trim();

  try {
    fs.mkdirSync(backupPath, { recursive: true });
    fs.accessSync(backupPath, fs.constants.W_OK);
    return { backupDir: backupPath, backupPath };
  } catch {
    // Backup drive not present/writable (e.g. removable drive unplugged) — record locally only.
    return { backupDir: null, backupPath };
  }
}

function formatUtcSessionTimestamp(date) {
  const pad = (value, length = 2) => String(value).padStart(length, "0");

  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
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
      fail(`FFmpeg stopped before it could start${formatExit(code, signal)}.${detail ? ` ${detail}` : " Check the FFmpeg path and OBS stream URL."}`);
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

    return `${message} Check that OBS is streaming to rtmp://127.0.0.1:1935/live with stream key emerald, then start recording again.`;
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
