const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { normalizeFfmpegPath } = require("./obsRecordingService");
const { isUdpInputUrl, normalizeInputUrl } = require("./ffmpegInputUrl");

const previewPath = "/hls/obs-preview/index.m3u8";

class ObsPreviewService {
  constructor(webRootPath) {
    this.previewRoot = path.join(webRootPath, "hls", "obs-preview");
    fs.mkdirSync(this.previewRoot, { recursive: true });
    this.process = null;
    this.status = {
      isRunning: false,
      startedAt: null,
      previewUrl: previewPath,
      lastMessage: null,
    };
  }

  async start(request) {
    if (!request.inputUrl || !String(request.inputUrl).trim()) {
      throw new Error("OBS recording URL is required before preview can start.");
    }

    if (this.isProcessRunning()) {
      return this.status;
    }

    this.cleanPreviewFiles();

    const ffmpegPath = normalizeFfmpegPath(request.ffmpegPath);
    const inputUrl = normalizeInputUrl(request.inputUrl);
    const isUdpInput = isUdpInputUrl(inputUrl);
    const playlistPath = path.join(this.previewRoot, "index.m3u8");
    const sessionId = String(Date.now());
    const segmentPattern = path.join(this.previewRoot, `segment-${sessionId}-%05d.ts`);
    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      ...buildUdpInputArgs(inputUrl),
      "-i", inputUrl,
      "-map", "0:v:0",
      "-map", "0:a?",
      ...buildPreviewCodecArgs(isUdpInput),
      "-f", "hls",
      "-hls_time", "2",
      "-hls_list_size", "10",
      "-hls_flags", "delete_segments+append_list+omit_endlist+independent_segments",
      "-hls_delete_threshold", "10",
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
      this.status = { ...this.status, isRunning: false, lastMessage: error.message };
      throw new Error(`Unable to start FFmpeg preview at '${ffmpegPath}'.`);
    }

    const startedProcess = this.process;

    startedProcess.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.status = { ...this.status, lastMessage: message };
      }
    });

    startedProcess.on("error", (error) => {
      this.status = { ...this.status, isRunning: false, startedAt: null, lastMessage: error.message };
      if (this.process === startedProcess) {
        this.process = null;
      }
    });

    startedProcess.on("exit", () => {
      this.status = { ...this.status, isRunning: false, lastMessage: explainFfmpegMessage(this.status.lastMessage || "Preview FFmpeg stopped.", inputUrl) };
      this.process = null;
    });

    this.status = {
      isRunning: true,
      startedAt: new Date().toISOString(),
      previewUrl: `${previewPath}?v=${sessionId}`,
      lastMessage: null,
    };

    await waitForFfmpegStartup(startedProcess, ffmpegPath, "Preview FFmpeg", () => this.status.lastMessage, inputUrl);

    try {
      await waitForPlaylistFile(startedProcess, playlistPath, () => this.status.lastMessage, inputUrl);
    } catch (error) {
      this.stop();
      this.status = { ...this.status, isRunning: false, lastMessage: error.message };
      throw error;
    }

    return this.status;
  }

  stop() {
    if (!this.process) {
      this.status = { ...this.status, isRunning: false };
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
    this.status = { ...this.status, isRunning: false, lastMessage: "Preview stopped." };
    return this.status;
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
  ObsPreviewService,
};

function waitForFfmpegStartup(process, ffmpegPath, label, getLastMessage, inputUrl) {
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
      const detail = explainFfmpegMessage(getLastMessage?.(), inputUrl);
      fail(`${label} stopped before preview could start${formatExit(code, signal)}.${detail ? ` ${detail}` : " Check the FFmpeg path and OBS stream URL."}`);
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
        reject(new Error(explainFfmpegMessage(getLastMessage() || "Preview FFmpeg stopped before creating the HLS playlist.", inputUrl)));
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
    "-max_delay", "500000",
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
