// Thin proxy over DeltacastCaptureService's local HTTP control surface for TX7 ("Push On Air").
// The actual SDI transmit logic (VideoMaster SDK, ffmpeg decode) lives entirely in that C#
// service — this just forwards requests and surfaces its responses/errors to the frontend.
class DeltacastTxService {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || process.env.DELTACAST_TX_SERVICE_URL || "http://127.0.0.1:5055").replace(/\/+$/, "");
  }

  async status() {
    return this.request("GET", "/tx/status");
  }

  async captureStatus() {
    return this.request("GET", "/capture/status");
  }

  // Installed SDI hardware and what each leg is currently using — backs the board/channel pickers
  // in Recording and Playback configuration. Taken from the C# service's startup inventory, so it
  // is cheap to poll and safe to call while capture and TX are live (see SdiChannelScanner).
  async boards() {
    return this.request("GET", "/boards");
  }

  // The on-air confidence monitor's own leg: which SDI input it is watching, and whether it is
  // locked onto it. Separate from boards() because it changes on its own (signal coming and going)
  // rather than only when an operator picks something.
  async onAirPreviewStatus() {
    return this.request("GET", "/onair-preview/status");
  }

  // Re-points that leg at a different input while the service runs. The C# side drops its current
  // RX stream and comes back on the new one within a few seconds — see OnAirPreviewService's
  // TryRebind for why this is accept-then-apply rather than synchronous, and why it refuses a
  // board that was not opened at startup.
  async setOnAirPreviewChannel({ enabled, boardIndex, channelIndex } = {}) {
    return this.request("POST", "/onair-preview/channel", { enabled, boardIndex, channelIndex });
  }

  // `startAt` ("beginning" | "delay") decides where a live HLS playlist is joined, overriding the
  // service's configured Transmit:HlsStartMode for this push only — see server.js's /api/tx/start
  // for why opening a session differs from resuming one. Omitted for non-playlist sources, which
  // have no history to join.
  async start(sourceUrl, { live = false, loop = true, startAt } = {}) {
    return this.request("POST", "/tx/start", { sourceUrl, live, loop, startAt });
  }

  async stop() {
    return this.request("POST", "/tx/stop");
  }

  // Operator lip-sync calibration held by the C# service (it owns the ffmpeg legs that take video
  // and audio separately, so it's the only place the shift can actually be applied). Setting it
  // restarts the live preview encoder within about a second so the change is immediately visible;
  // an in-progress recording keeps the value it started with.
  async audioCalibration() {
    return this.request("GET", "/audio-calibration");
  }

  async setAudioCalibration(offsetMs) {
    return this.request("POST", "/audio-calibration", { offsetMs });
  }

  async request(method, path, body) {
    let response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new Error(`Unable to reach DeltacastCaptureService at ${this.baseUrl}. Is it running? (${error.message})`);
    }

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.message || `DeltacastCaptureService returned ${response.status}.`);
    }

    return result;
  }
}

module.exports = {
  DeltacastTxService,
};
