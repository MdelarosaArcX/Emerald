const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { normalizeFfmpegPath } = require("./obsRecordingService");

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

  start(request) {
    if (!request.inputUrl || !String(request.inputUrl).trim()) {
      throw new Error("OBS recording URL is required before preview can start.");
    }

    if (this.isProcessRunning()) {
      return this.status;
    }

    this.cleanPreviewFiles();

    const ffmpegPath = normalizeFfmpegPath(request.ffmpegPath);
    const playlistPath = path.join(this.previewRoot, "index.m3u8");
    const sessionId = String(Date.now());
    const segmentPattern = path.join(this.previewRoot, `segment-${sessionId}-%05d.ts`);
    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      "-i", String(request.inputUrl).trim(),
      "-map", "0:v:0",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-tune", "zerolatency",
      "-profile:v", "main",
      "-pix_fmt", "yuv420p",
      "-g", "60",
      "-keyint_min", "60",
      "-sc_threshold", "0",
      "-c:a", "aac",
      "-b:a", "128k",
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

    this.process.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.status = { ...this.status, lastMessage: message };
      }
    });

    this.process.on("error", (error) => {
      this.status = { ...this.status, isRunning: false, lastMessage: error.message };
    });

    this.process.on("exit", () => {
      this.status = { ...this.status, isRunning: false, lastMessage: explainFfmpegMessage(this.status.lastMessage || "Preview FFmpeg stopped.") };
      this.process = null;
    });

    this.status = {
      isRunning: true,
      startedAt: new Date().toISOString(),
      previewUrl: `${previewPath}?v=${sessionId}`,
      lastMessage: null,
    };

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
    return Boolean(this.process && !this.process.killed);
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

function explainFfmpegMessage(message) {
  if (message && message.toLowerCase().includes("error opening input")) {
    return `${message} Check that OBS is streaming to rtmp://127.0.0.1:1935/live with stream key emerald, then start recording again.`;
  }

  return message;
}
