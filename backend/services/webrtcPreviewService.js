const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { normalizeFfmpegPath } = require("./obsRecordingService");
const { isUdpInputUrl, normalizeInputUrl } = require("./ffmpegInputUrl");

const DEFAULT_STREAM_PATH = "live/preview";

// MediaMTX is a single shared server process. Every WebrtcPreviewService instance publishes its
// own path to the same MediaMTX instance, so its process lifecycle is tracked at module scope
// instead of per instance — otherwise a second instance would try to spawn a second mediamtx.exe
// and fail to bind the already-claimed RTSP/WHEP ports.
let mediaMtxProcess = null;

class WebrtcPreviewService {
  constructor(options = {}) {
    this.streamPath = options.streamPath || DEFAULT_STREAM_PATH;
    this.mediaMtxPath = options.mediaMtxPath || process.env.MEDIAMTX_PATH || path.join(__dirname, "..", "..", "..", "MediaMtx", "mediamtx.exe");
    this.mediaMtxConfigPath = options.mediaMtxConfigPath || process.env.MEDIAMTX_CONFIG_PATH || path.join(path.dirname(this.mediaMtxPath), "mediamtx.yml");
    this.rtspPort = Number(process.env.MEDIAMTX_RTSP_PORT || 8554);
    this.whepPort = Number(process.env.MEDIAMTX_WHEP_PORT || 8889);
    this.publicHost = process.env.MEDIAMTX_PUBLIC_HOST || "127.0.0.1";
    // Opt-in: an instance with no user-facing start/stop control (auto-started at boot, never
    // explicitly restarted by the frontend) would need to recover on its own from ffmpeg exiting
    // unexpectedly. Off by default so instances with a real start/stop button (Capture page)
    // don't unexpectedly reappear after an intentional stop.
    this.autoRestart = Boolean(options.autoRestart);
    this.restartTimer = null;
    this.lastStartRequest = null;
    this.stopping = false;

    this.publishProcess = null;
    this.status = {
      isRunning: false,
      startedAt: null,
      inputUrl: null,
      whepUrl: `http://${this.publicHost}:${this.whepPort}/${this.streamPath}/whep`,
      lastMessage: null,
    };
  }

  async start(request) {
    if (!request.inputUrl || !String(request.inputUrl).trim()) {
      throw new Error("Input URL is required for the WebRTC preview.");
    }

    this.stopping = false;
    this.lastStartRequest = request;

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
    const rtspUrl = `rtsp://127.0.0.1:${this.rtspPort}/${this.streamPath}`;

    const args = [
      "-hide_banner",
      // info-level logs flow into this.status.lastMessage so startup failures are visible
      // in the frontend message field even if they don't reach warning severity.
      "-loglevel", "info",
      // Declare the input format so FFmpeg skips probing and publishes within a second.
      ...(isUdpInput ? ["-f", "mpegts", "-fflags", "+discardcorrupt", "-max_delay", "200000"] : []),
      "-i", inputUrl,
      "-map", "0:v:0",
      // "?" makes the audio map optional — the upstream MPEG-TS only carries an AAC track when
      // DeltacastCaptureService's CaptureOptions.EnableAudio is on (still off by default), so
      // this stays a harmless no-op (today's exact video-only behavior) until it is. WebRTC/WHEP
      // requires Opus, not AAC, so this transcodes rather than passing the AAC track through —
      // same reasoning as OnAirPreviewStreamingService.cs's on-air preview leg.
      "-map", "0:a:0?",
      "-c:v", "copy",
      "-c:a", "libopus", "-b:a", "128k", "-ar", "48000",
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
        this.maybeScheduleRestart();
      }
    });

    process.on("exit", () => {
      if (this.publishProcess === process) {
        this.status = { ...this.status, isRunning: false, lastMessage: this.status.lastMessage || "WebRTC preview publisher stopped." };
        this.publishProcess = null;
        this.maybeScheduleRestart();
      }
    });

    this.status = {
      isRunning: true,
      startedAt: new Date().toISOString(),
      inputUrl,
      whepUrl: `http://${this.publicHost}:${this.whepPort}/${this.streamPath}/whep`,
      lastMessage: null,
    };

    return this.status;
  }

  stop() {
    this.stopping = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.publishProcess && !this.publishProcess.killed) {
      this.publishProcess.kill("SIGKILL");
    }

    this.publishProcess = null;
    this.status = { ...this.status, isRunning: false, lastMessage: "WebRTC preview stopped." };
    return this.status;
  }

  // Only fires for an unexpected exit (ffmpeg crashing, e.g. "Conversion failed!" from an
  // upstream stream discontinuity) — `stopping` is set synchronously by stop() before it kills
  // the process, so an intentional stop never triggers this.
  maybeScheduleRestart() {
    if (!this.autoRestart || this.stopping || !this.lastStartRequest || this.restartTimer) {
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping && this.lastStartRequest) {
        this.start(this.lastStartRequest).catch((error) => {
          this.status = { ...this.status, lastMessage: error.message };
        });
      }
    }, 2000);
    this.restartTimer.unref?.();
  }

  // Stops this instance's publisher only. MediaMTX itself is shared across every
  // WebrtcPreviewService instance — call stopSharedMediaMtx() once during process shutdown to
  // stop it, not per instance.
  stopAll() {
    this.stop();
  }

  ensureMediaMtxRunning() {
    if (mediaMtxProcess && mediaMtxProcess.exitCode === null && mediaMtxProcess.signalCode === null) {
      return;
    }

    const proc = spawn(this.mediaMtxPath, [this.mediaMtxConfigPath], {
      cwd: path.dirname(this.mediaMtxPath),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.status = { ...this.status, lastMessage: message };
      }
    });

    proc.on("exit", () => {
      if (mediaMtxProcess === proc) {
        mediaMtxProcess = null;
      }
    });

    mediaMtxProcess = proc;
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

function stopSharedMediaMtx() {
  if (mediaMtxProcess && !mediaMtxProcess.killed) {
    mediaMtxProcess.kill();
  }
  mediaMtxProcess = null;
}

module.exports = {
  WebrtcPreviewService,
  stopSharedMediaMtx,
};
