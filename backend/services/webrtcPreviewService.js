const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { normalizeFfmpegPath } = require("./obsRecordingService");
const { isUdpInputUrl, normalizeInputUrl } = require("./ffmpegInputUrl");

const STREAM_PATH = "live/preview";

class WebrtcPreviewService {
  constructor(options = {}) {
    this.mediaMtxPath = options.mediaMtxPath || process.env.MEDIAMTX_PATH || path.join(__dirname, "..", "..", "..", "MediaMtx", "mediamtx.exe");
    this.mediaMtxConfigPath = options.mediaMtxConfigPath || process.env.MEDIAMTX_CONFIG_PATH || path.join(path.dirname(this.mediaMtxPath), "mediamtx.yml");
    this.rtspPort = Number(process.env.MEDIAMTX_RTSP_PORT || 8554);
    this.whepPort = Number(process.env.MEDIAMTX_WHEP_PORT || 8889);
    this.publicHost = process.env.MEDIAMTX_PUBLIC_HOST || "127.0.0.1";

    this.mediaMtxProcess = null;
    this.publishProcess = null;
    this.status = {
      isRunning: false,
      startedAt: null,
      inputUrl: null,
      whepUrl: `http://${this.publicHost}:${this.whepPort}/${STREAM_PATH}/whep`,
      lastMessage: null,
    };
  }

  async start(request) {
    if (!request.inputUrl || !String(request.inputUrl).trim()) {
      throw new Error("Input URL is required for the WebRTC preview.");
    }

    if (this.isPublishRunning()) {
      return this.status;
    }

    if (!fs.existsSync(this.mediaMtxPath)) {
      throw new Error(`MediaMTX was not found at '${this.mediaMtxPath}'. Set MEDIAMTX_PATH in backend/.env or place mediamtx.exe in the MediaMtx folder.`);
    }

    this.ensureMediaMtxRunning();
    await this.waitForMediaMtxReady(this.rtspPort);
    await this.waitForMediaMtxReady(this.whepPort);

    const ffmpegPath = normalizeFfmpegPath(request.ffmpegPath);
    const inputUrl = normalizeInputUrl(request.inputUrl);
    const isUdpInput = isUdpInputUrl(inputUrl);
    const rtspUrl = `rtsp://127.0.0.1:${this.rtspPort}/${STREAM_PATH}`;

    const args = [
      "-hide_banner",
      // info-level logs flow into this.status.lastMessage so startup failures are visible
      // in the frontend message field even if they don't reach warning severity.
      "-loglevel", "info",
      // Declare the input format so FFmpeg skips probing and publishes within a second.
      ...(isUdpInput ? ["-f", "mpegts", "-fflags", "+discardcorrupt", "-max_delay", "200000"] : []),
      "-i", inputUrl,
      "-map", "0:v:0",
      "-an",
      "-c:v", "copy",
      // TCP avoids dynamic UDP RTP port negotiation which can fail silently on Windows.
      "-rtsp_transport", "tcp",
      "-f", "rtsp",
      rtspUrl,
    ];

    let process;
    try {
      process = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.status = { ...this.status, isRunning: false, lastMessage: error.message };
      throw new Error(`Unable to start FFmpeg at '${ffmpegPath}' for the WebRTC preview.`);
    }

    this.publishProcess = process;

    process.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.status = { ...this.status, lastMessage: message };
      }
    });

    process.on("error", (error) => {
      this.status = { ...this.status, isRunning: false, lastMessage: error.message };
      if (this.publishProcess === process) {
        this.publishProcess = null;
      }
    });

    process.on("exit", () => {
      if (this.publishProcess === process) {
        this.status = { ...this.status, isRunning: false, lastMessage: this.status.lastMessage || "WebRTC preview publisher stopped." };
        this.publishProcess = null;
      }
    });

    this.status = {
      isRunning: true,
      startedAt: new Date().toISOString(),
      inputUrl,
      whepUrl: `http://${this.publicHost}:${this.whepPort}/${STREAM_PATH}/whep`,
      lastMessage: null,
    };

    return this.status;
  }

  stop() {
    if (this.publishProcess && !this.publishProcess.killed) {
      this.publishProcess.kill("SIGKILL");
    }

    this.publishProcess = null;
    this.status = { ...this.status, isRunning: false, lastMessage: "WebRTC preview stopped." };
    return this.status;
  }

  stopAll() {
    this.stop();

    if (this.mediaMtxProcess && !this.mediaMtxProcess.killed) {
      this.mediaMtxProcess.kill();
    }

    this.mediaMtxProcess = null;
  }

  ensureMediaMtxRunning() {
    if (this.mediaMtxProcess && this.mediaMtxProcess.exitCode === null && this.mediaMtxProcess.signalCode === null) {
      return;
    }

    const mediaMtxProcess = spawn(this.mediaMtxPath, [this.mediaMtxConfigPath], {
      cwd: path.dirname(this.mediaMtxPath),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    mediaMtxProcess.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.status = { ...this.status, lastMessage: message };
      }
    });

    mediaMtxProcess.on("exit", () => {
      if (this.mediaMtxProcess === mediaMtxProcess) {
        this.mediaMtxProcess = null;
      }
    });

    this.mediaMtxProcess = mediaMtxProcess;
  }

  waitForMediaMtxReady(port, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;

      const attempt = () => {
        const socket = net.connect({ host: "127.0.0.1", port });

        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });

        socket.once("error", () => {
          socket.destroy();

          if (Date.now() >= deadline) {
            reject(new Error(`MediaMTX did not start listening on port ${port} in time.`));
            return;
          }

          setTimeout(attempt, 100);
        });
      };

      attempt();
    });
  }

  isPublishRunning() {
    return Boolean(this.publishProcess && !this.publishProcess.killed && this.publishProcess.exitCode === null && this.publishProcess.signalCode === null);
  }
}

module.exports = {
  WebrtcPreviewService,
};
