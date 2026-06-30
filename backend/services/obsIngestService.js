const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { normalizeFfmpegPath } = require("./obsRecordingService");
const { isUdpInputUrl, normalizeInputUrl } = require("./ffmpegInputUrl");

const previewPath = "/hls/obs-preview/index.m3u8";

class ObsIngestService {
  constructor(recordingsPath, webRootPath) {
    this.recordingsPath = recordingsPath;
    this.previewRoot = path.join(webRootPath, "hls", "obs-preview");
    fs.mkdirSync(this.previewRoot, { recursive: true });
    this.process = null;
    this.recordingStatus = {
      isRecording: false,
      startedAt: null,
      inputUrl: null,
      outputPattern: null,
      segmentSeconds: 120,
      container: "mp4",
      lastMessage: null,
    };
    this.previewStatus = {
      isRunning: false,
      startedAt: null,
      previewUrl: previewPath,
      lastMessage: null,
    };
  }

  async start(request) {
    if (!request.inputUrl || !String(request.inputUrl).trim()) {
      throw new Error("OBS recording URL is required.");
    }

    if (this.isProcessRunning()) {
      return { recordingStatus: this.recordingStatus, previewStatus: this.previewStatus };
    }

    this.cleanPreviewFiles();

    const segmentSeconds = clamp(Number(request.segmentSeconds || 120), 10, 3600);
    const container = normalizeContainer(request.container);
    const ffmpegPath = normalizeFfmpegPath(request.ffmpegPath);
    const inputUrl = normalizeInputUrl(request.inputUrl);
    const isUdpInput = isUdpInputUrl(inputUrl);
    const outputPattern = path.join(this.recordingsPath, `obs-%Y%m%d-%H%M%S.${container.extension}`);
    const playlistPath = path.join(this.previewRoot, "index.m3u8");
    const sessionId = String(Date.now());
    const segmentPattern = path.join(this.previewRoot, `segment-${sessionId}-%05d.ts`);

    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      ...buildUdpInputArgs(inputUrl),
      "-i", inputUrl,
      "-map", "0",
      "-c", "copy",
      "-f", "segment",
      "-segment_time", String(segmentSeconds),
      "-reset_timestamps", "1",
      "-strftime", "1",
      "-segment_format", container.format,
      outputPattern,
      "-map", "0:v:0",
      "-map", "0:a?",
      ...buildPreviewCodecArgs(isUdpInput),
      "-f", "hls",
      "-hls_time", "0.32",
      "-hls_list_size", "12",
      "-hls_flags", "delete_segments+append_list+omit_endlist+independent_segments",
      "-hls_delete_threshold", "12",
      "-hls_segment_filename", segmentPattern,
      playlistPath,
    ];

    try {
      this.process = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.process = null;
      this.recordingStatus = { ...this.recordingStatus, isRecording: false, lastMessage: error.message };
      this.previewStatus = { ...this.previewStatus, isRunning: false, lastMessage: error.message };
      throw new Error(`Unable to start FFmpeg at '${ffmpegPath}'. Use the full path to ffmpeg.exe or a folder that contains ffmpeg.exe.`);
    }

    const startedProcess = this.process;

    startedProcess.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.recordingStatus = { ...this.recordingStatus, lastMessage: message };
        this.previewStatus = { ...this.previewStatus, lastMessage: message };
      }
    });

    startedProcess.on("error", (error) => {
      this.recordingStatus = { ...this.recordingStatus, isRecording: false, startedAt: null, lastMessage: error.message };
      this.previewStatus = { ...this.previewStatus, isRunning: false, startedAt: null, lastMessage: error.message };
      if (this.process === startedProcess) {
        this.process = null;
      }
    });

    startedProcess.on("exit", () => {
      const detail = explainFfmpegMessage(this.recordingStatus.lastMessage || "FFmpeg stopped.", inputUrl);
      this.recordingStatus = { ...this.recordingStatus, isRecording: false, lastMessage: detail };
      this.previewStatus = { ...this.previewStatus, isRunning: false, lastMessage: detail };
      this.process = null;
    });

    this.recordingStatus = {
      isRecording: true,
      startedAt: new Date().toISOString(),
      inputUrl,
      outputPattern,
      segmentSeconds,
      container: container.extension,
      lastMessage: null,
    };
    this.previewStatus = {
      isRunning: true,
      startedAt: new Date().toISOString(),
      previewUrl: `${previewPath}?v=${sessionId}`,
      lastMessage: null,
    };

    await waitForFfmpegStartup(startedProcess, ffmpegPath, () => this.recordingStatus.lastMessage, inputUrl);

    try {
      await waitForPlaylistFile(startedProcess, playlistPath, () => this.previewStatus.lastMessage, inputUrl);
    } catch (error) {
      this.stop();
      this.previewStatus = { ...this.previewStatus, isRunning: false, lastMessage: error.message };
      throw error;
    }

    return { recordingStatus: this.recordingStatus, previewStatus: this.previewStatus };
  }

  stop() {
    if (!this.process) {
      this.recordingStatus = { ...this.recordingStatus, isRecording: false };
      this.previewStatus = { ...this.previewStatus, isRunning: false };
      return { recordingStatus: this.recordingStatus, previewStatus: this.previewStatus };
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
    this.recordingStatus = { ...this.recordingStatus, isRecording: false, lastMessage: "Recording stopped." };
    this.previewStatus = { ...this.previewStatus, isRunning: false, lastMessage: "Preview stopped." };
    return { recordingStatus: this.recordingStatus, previewStatus: this.previewStatus };
  }

  isProcessRunning() {
    return Boolean(this.process && !this.process.killed && this.process.exitCode === null && this.process.signalCode === null);
  }

  cleanPreviewFiles() {
    for (const fileName of fs.readdirSync(this.previewRoot)) {
      fs.rmSync(path.join(this.previewRoot, fileName), { force: true, recursive: true });
    }
  }
}

module.exports = {
  ObsIngestService,
};

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

function waitForPlaylistFile(process, playlistPath, getLastMessage, inputUrl) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timeoutMs = 12000;

    const check = () => {
      if (fs.existsSync(playlistPath) && fs.statSync(playlistPath).size > 0) {
        resolve();
        return;
      }

      if (process.exitCode !== null || process.signalCode !== null || process.killed) {
        reject(new Error(explainFfmpegMessage(getLastMessage() || "FFmpeg stopped before creating the HLS playlist.", inputUrl)));
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(explainFfmpegMessage(getLastMessage() || "Preview HLS playlist was not created. Check that the configured input stream is sending video.", inputUrl)));
        return;
      }

      setTimeout(check, 250).unref();
    };

    check();
  });
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

  return [
    "-fflags", "+discardcorrupt",
    "-probesize", "50M",
    "-analyzeduration", "50M",
    "-max_delay", "200000",
  ];
}

function buildPreviewCodecArgs(isUdpInput) {
  if (isUdpInput) {
    return [
      "-c", "copy",
    ];
  }

  return [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-profile:v", "main",
    "-pix_fmt", "yuv420p",
    "-g", "60",
    "-keyint_min", "60",
    "-sc_threshold", "0",
    "-c:a", "aac",
  ];
}
