const { spawn } = require("node:child_process");
const { normalizeFfmpegPath } = require("./obsRecordingService");
const { isUdpInputUrl, normalizeInputUrl } = require("./ffmpegInputUrl");

class RtmpOutService {
  constructor() {
    this.process = null;
    this.status = {
      isBroadcasting: false,
      startedAt: null,
      inputUrl: null,
      destinationUrl: null,
      lastMessage: null,
    };
  }

  async start(request) {
    if (!request.inputUrl || !String(request.inputUrl).trim()) {
      throw new Error("Input URL is required to go live.");
    }

    const destinationUrl = buildDestinationUrl(request.destinationUrl, request.streamKey);
    if (!destinationUrl) {
      throw new Error("A destination RTMP URL (and stream key, if required) is needed to go live.");
    }

    if (this.isProcessRunning()) {
      return this.status;
    }

    const ffmpegPath = normalizeFfmpegPath(request.ffmpegPath);
    const inputUrl = normalizeInputUrl(request.inputUrl);
    const audioBitrate = String(request.audioBitrate || "").match(/\d+/)?.[0] || "128";

    const args = [
      "-hide_banner",
      "-loglevel", "info",
      ...(isUdpInputUrl(inputUrl) ? ["-f", "mpegts", "-fflags", "+discardcorrupt", "-max_delay", "200000"] : []),
      "-i", inputUrl,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", `${audioBitrate}k`,
      "-f", "flv",
      destinationUrl,
    ];

    let process;
    try {
      process = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.status = { ...this.status, isBroadcasting: false, lastMessage: error.message };
      throw new Error(`Unable to start FFmpeg at '${ffmpegPath}' to go live.`);
    }

    this.process = process;

    process.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.status = { ...this.status, lastMessage: message };
      }
    });

    process.on("error", (error) => {
      this.status = { ...this.status, isBroadcasting: false, lastMessage: error.message };
      if (this.process === process) {
        this.process = null;
      }
    });

    process.on("exit", () => {
      if (this.process === process) {
        this.status = { ...this.status, isBroadcasting: false, lastMessage: this.status.lastMessage || "Live broadcast stopped." };
        this.process = null;
      }
    });

    this.status = {
      isBroadcasting: true,
      startedAt: new Date().toISOString(),
      inputUrl,
      destinationUrl: redactStreamKey(destinationUrl),
      lastMessage: null,
    };

    return this.status;
  }

  stop() {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGKILL");
    }

    this.process = null;
    this.status = { ...this.status, isBroadcasting: false, lastMessage: "Live broadcast stopped." };
    return this.status;
  }

  isProcessRunning() {
    return Boolean(this.process && !this.process.killed && this.process.exitCode === null && this.process.signalCode === null);
  }
}

function buildDestinationUrl(destinationUrl, streamKey) {
  const trimmedUrl = String(destinationUrl || "").trim();
  if (!trimmedUrl) return null;

  const trimmedKey = String(streamKey || "").trim();
  if (!trimmedKey) return trimmedUrl;

  return `${trimmedUrl.replace(/\/+$/, "")}/${trimmedKey}`;
}

// Stream keys are secrets — never echo them back to the frontend once the broadcast has started.
function redactStreamKey(destinationUrl) {
  const segments = destinationUrl.split("/");
  if (segments.length <= 3) return destinationUrl;

  segments[segments.length - 1] = "****";
  return segments.join("/");
}

module.exports = {
  RtmpOutService,
};
