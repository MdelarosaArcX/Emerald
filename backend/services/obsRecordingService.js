const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const staticFfmpegPath = require("ffmpeg-static");

class ObsRecordingService {
  constructor(recordingsPath) {
    this.recordingsPath = recordingsPath;
    this.process = null;
    this.status = {
      isRecording: false,
      startedAt: null,
      inputUrl: null,
      outputPattern: null,
      segmentSeconds: 120,
      container: "mp4",
      lastMessage: null,
    };
  }

  async start(request) {
    if (!request.inputUrl || !String(request.inputUrl).trim()) {
      throw new Error("OBS recording URL is required.");
    }

    if (this.isProcessRunning()) {
      return this.status;
    }

    const segmentSeconds = clamp(Number(request.segmentSeconds || 120), 10, 3600);
    const container = normalizeContainer(request.container);
    const ffmpegPath = normalizeFfmpegPath(request.ffmpegPath);
    const outputPattern = path.join(this.recordingsPath, `obs-%Y%m%d-%H%M%S.${container.extension}`);
    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      "-i", String(request.inputUrl).trim(),
      "-map", "0",
      "-c", "copy",
      "-f", "segment",
      "-segment_time", String(segmentSeconds),
      "-reset_timestamps", "1",
      "-strftime", "1",
      "-segment_format", container.format,
      outputPattern,
    ];

    try {
      this.process = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.process = null;
      this.status = { ...this.status, isRecording: false, lastMessage: error.message };
      throw new Error(`Unable to start FFmpeg at '${ffmpegPath}'. Use the full path to ffmpeg.exe or a folder that contains ffmpeg.exe.`);
    }

    const startedProcess = this.process;

    startedProcess.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.status = { ...this.status, lastMessage: message };
      }
    });

    startedProcess.on("error", (error) => {
      this.status = { ...this.status, isRecording: false, startedAt: null, lastMessage: error.message };
      if (this.process === startedProcess) {
        this.process = null;
      }
    });

    startedProcess.on("exit", () => {
      this.status = { ...this.status, isRecording: false, lastMessage: explainFfmpegMessage(this.status.lastMessage || "FFmpeg stopped.") };
      this.process = null;
    });

    this.status = {
      isRecording: true,
      startedAt: new Date().toISOString(),
      inputUrl: String(request.inputUrl).trim(),
      outputPattern,
      segmentSeconds,
      container: container.extension,
      lastMessage: null,
    };

    await waitForFfmpegStartup(startedProcess, ffmpegPath, "FFmpeg", () => this.status.lastMessage);
    return this.status;
  }

  stop() {
    if (!this.process) {
      this.status = { ...this.status, isRecording: false };
      return this.status;
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

    this.process = null;
    this.status = { ...this.status, isRecording: false, lastMessage: "Recording stopped." };
    return this.status;
  }

  isProcessRunning() {
    return Boolean(this.process && !this.process.killed && this.process.exitCode === null && this.process.signalCode === null);
  }
}

function normalizeContainer(container) {
  switch (String(container || "").trim().toLowerCase()) {
    case "mkv":
    case "matroska":
      return { extension: "mkv", format: "matroska" };
    case "ts":
    case "mpegts":
      return { extension: "ts", format: "mpegts" };
    default:
      return { extension: "mp4", format: "mp4" };
  }
}

function normalizeFfmpegPath(configuredPath) {
  const rawPath = !configuredPath || !String(configuredPath).trim() || String(configuredPath).trim().toLowerCase() === "ffmpeg"
    ? process.env.FFMPEG_PATH || staticFfmpegPath || configuredPath || "ffmpeg"
    : configuredPath;
  const trimmedPath = String(rawPath).trim().replace(/^"|"$/g, "");

  if (fs.existsSync(trimmedPath) && fs.statSync(trimmedPath).isDirectory()) {
    return path.join(trimmedPath, os.platform() === "win32" ? "ffmpeg.exe" : "ffmpeg");
  }

  return trimmedPath;
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

module.exports = {
  ObsRecordingService,
  normalizeFfmpegPath,
};

function waitForFfmpegStartup(process, ffmpegPath, label, getLastMessage) {
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
      fail(formatFfmpegStartError(label, ffmpegPath, error));
    };

    const onExit = (code, signal) => {
      const detail = explainFfmpegMessage(getLastMessage?.());
      fail(`${label} stopped before recording could start${formatExit(code, signal)}.${detail ? ` ${detail}` : " Check the FFmpeg path and OBS stream URL."}`);
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

function formatFfmpegStartError(label, ffmpegPath, error) {
  if (error?.code === "ENOENT") {
    return `Unable to start ${label} at '${ffmpegPath}'. FFmpeg was not found. Install FFmpeg and add it to PATH, set FFMPEG_PATH in backend/.env, or paste the full path to ffmpeg.exe in the FFmpeg Path field.`;
  }

  return `Unable to start ${label} at '${ffmpegPath}'. ${error?.message || "Check the FFmpeg path."}`;
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

function explainFfmpegMessage(message) {
  if (message && message.toLowerCase().includes("error opening input")) {
    return `${message} Check that OBS is streaming to rtmp://127.0.0.1:1935/live with stream key emerald, then start recording again.`;
  }

  return message;
}
