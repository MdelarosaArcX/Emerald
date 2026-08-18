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

  async start(sourceUrl, { live = false, loop = true } = {}) {
    return this.request("POST", "/tx/start", { sourceUrl, live, loop });
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
