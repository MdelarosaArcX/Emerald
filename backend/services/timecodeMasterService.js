const os = require("node:os");
const {
  formatWallClockTimecode,
  timeReferenceSamples,
  timecodeDifferenceInFrames,
} = require("./timecodeFormat");

// Client for the Timecode System generator (Timecode.Master.exe running in Generator mode), which
// serves a small JSON API over Kestrel:
//
//   GET /api/timecode  -> current timecode, frameRate, timecodeType, sourceStatus, connectedReaders
//   GET /api/sync      -> the same, plus a four-timestamp exchange for clock offset measurement
//   GET /api/readers   -> every connected reader's measured offset/latency/sync state
//
// This is the single source of timecode for the whole backend. Everything that used to format the
// local wall clock and call it "timecode" now goes through here instead.
//
// The hot path never touches the network. Polling the master per frame would be both wasteful and
// *less* accurate — HTTP round-trip jitter (~1ms, but occasionally far worse under load) would be
// baked straight into the answer. Instead this measures the offset between our clock and the
// master's a few times a minute, and every timecode read after that is pure local arithmetic:
// Date.now() + offsetMs. That is how the vendor's own Reader app works, and it is what lets
// obsIngestService/EditCaptureService stamp a start timecode at the exact instant they spawn
// ffmpeg rather than a network round-trip earlier.

const DEFAULT_MASTER_URL = "http://10.0.0.33:8888";
// Matches the vendor Reader's own SyncIntervalSeconds: 2 (see the Timecode System appsettings.json).
const SYNC_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 3000;
// Enough history to have a stable median round-trip to reject outliers against, without holding on
// to samples old enough that real clock drift looks like an outlier.
const SAMPLE_WINDOW = 8;
// A sample whose round-trip is far above the recent median spent an unknown, asymmetric amount of
// that time queued (GC pause here, burst on the wire there), so its midpoint estimate of the
// offset is untrustworthy. Averaging it in would drag the offset around by milliseconds.
const RTT_OUTLIER_MULTIPLIER = 3;
// Below this the network is quiet enough that outlier rejection would be discarding samples over
// sub-millisecond noise that doesn't matter at 40ms-per-frame.
const RTT_OUTLIER_FLOOR_MS = 5;
// How long without a successful sync before the lock is called lost.
//
// Generous on purpose. A missed sync does not mean the timecode has gone wrong: the offset it
// measured is still good, and two machines' clocks drift apart by microseconds over this window,
// not frames. What a gap usually means is that this process was too busy to run the timer — the
// backend's event loop stalls for seconds at a time under recording start and segment
// reconciliation (see obsIngestService's stderr-throttling comment for a documented case). At
// 10s that produced a stream of spurious "generator unreachable" events and a flickering UI badge
// while the timecode being served was in fact correct the whole time. Real loss of the generator
// still gets caught; it just has to persist rather than being a hiccup.
const STALE_AFTER_MS = 30000;
// Back-to-back syncs on startup to get past the first request's connection-setup cost.
const PRIME_SAMPLES = 3;
// /api/sync carries the timecode and frame rate but not the generator's own health fields
// (sourceStatus, connectedReaders) — only /api/timecode does. Those change rarely, so they get
// refreshed every few ticks rather than doubling the request rate for the whole sync loop.
const METADATA_REFRESH_EVERY_TICKS = 5;

const LOCK_STATE = {
  LOCKED: "LOCKED",
  FREE_RUN: "FREE_RUN",
  MISMATCH: "MISMATCH",
};

const DEFAULT_FRAME_RATE = 25;

class TimecodeMasterService {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || process.env.EMERALD_TIMECODE_MASTER_URL || DEFAULT_MASTER_URL).replace(/\/+$/, "");
    this.readerId = options.readerId || process.env.EMERALD_TIMECODE_READER_ID || `emerald-backend-${os.hostname()}`;
    this.displayName = options.displayName || "Emerald Backend";
    this.syncIntervalMs = options.syncIntervalMs || SYNC_INTERVAL_MS;

    this.timer = null;
    this.offsetMs = 0;
    this.latencyMs = null;
    this.frameRate = DEFAULT_FRAME_RATE;
    this.timecodeType = null;
    this.sourceStatus = null;
    this.connectedReaders = null;
    this.lastSyncAt = null;
    this.lastError = null;
    this.driftFrames = null;
    this.rttSamples = [];
    this.tickCount = 0;
  }

  start() {
    if (this.timer) return;
    // Prime immediately so a recording started seconds after boot already has a measured offset
    // rather than silently falling back to the uncorrected local clock. Several samples back to
    // back, because the very first request to the master pays connection-setup cost — measured at
    // ~36ms round trip against ~2ms for every request after it — and outlier rejection can't help
    // on a cold start with no median to compare against. Without this the first few seconds of
    // uptime carry an offset that is tens of milliseconds wrong.
    this.prime();
    this.timer = setInterval(() => this.tick(), this.syncIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async prime() {
    for (let attempt = 0; attempt < PRIME_SAMPLES; attempt += 1) {
      await this.tick();
    }
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  // ---- the hot path: no network, safe to call at any rate ----

  // "Now" on the generator's clock. Everything that needs a generator-accurate instant — a start
  // timecode, a BWF sample stamp — should build it from this rather than from `new Date()`.
  currentDate() {
    return new Date(Date.now() + this.offsetMs);
  }

  currentTimecode() {
    return formatWallClockTimecode(this.currentDate(), this.frameRate);
  }

  // Timecode at an instant offset from now, for the on-air feed's broadcast delay.
  timecodeAt(date) {
    return formatWallClockTimecode(date, this.frameRate);
  }

  timecodeSecondsAgo(seconds) {
    return this.timecodeAt(new Date(this.currentDate().getTime() - seconds * 1000));
  }

  // Timecode for an instant that was stamped by *this machine's* clock rather than read from
  // here — a segment file's birthtime, a timestamp reported by the C# capture service. Those
  // carry the local clock's error, so the measured offset has to be applied to them before they
  // can be expressed as generator timecode.
  timecodeAtLocalInstant(date) {
    return this.timecodeAt(new Date(date.getTime() + this.offsetMs));
  }

  // Samples since local midnight on the generator's clock, for a BWF bext stamp.
  currentTimeReferenceSamples(sampleRate = 48000) {
    return timeReferenceSamples(this.currentDate(), sampleRate);
  }

  get lockState() {
    if (this.driftFrames !== null && Math.abs(this.driftFrames) > 1) return LOCK_STATE.MISMATCH;
    if (!this.lastSyncAt) return LOCK_STATE.FREE_RUN;
    if (Date.now() - this.lastSyncAt.getTime() > STALE_AFTER_MS) return LOCK_STATE.FREE_RUN;
    // The master reports its own upstream health; if it isn't locked to its time source then
    // neither are we, however good our measurement of the offset to it happens to be.
    if (this.sourceStatus && this.sourceStatus.toUpperCase() !== "LOCKED") return LOCK_STATE.FREE_RUN;
    return LOCK_STATE.LOCKED;
  }

  // Attached to every timecode the backend serves or stores, so a value produced while the
  // generator was unreachable is identifiable as such after the fact instead of being
  // indistinguishable from a real one.
  get status() {
    const lockState = this.lockState;
    return {
      source: lockState === LOCK_STATE.LOCKED ? "master" : "wallclock",
      lockState,
      masterUrl: this.baseUrl,
      readerId: this.readerId,
      frameRate: this.frameRate,
      timecodeType: this.timecodeType,
      sourceStatus: this.sourceStatus,
      offsetMs: Number(this.offsetMs.toFixed(3)),
      latencyMs: this.latencyMs === null ? null : Number(this.latencyMs.toFixed(3)),
      driftFrames: this.driftFrames === null ? null : Number(this.driftFrames.toFixed(2)),
      connectedReaders: this.connectedReaders,
      lastSyncAt: this.lastSyncAt ? this.lastSyncAt.toISOString() : null,
      lastError: this.lastError,
    };
  }

  // ---- the sync path ----

  async tick() {
    try {
      await this.sync();
      if (this.tickCount % METADATA_REFRESH_EVERY_TICKS === 0) {
        this.applyMasterMetadata(await this.request("/api/timecode"));
      }
      this.tickCount += 1;
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      // Deliberately keep the last known offset rather than resetting it to 0: a generator that
      // has just gone missing is far better approximated by the offset measured seconds ago than
      // by pretending our clock was correct all along. lockState still reports FREE_RUN once the
      // last successful sync goes stale, so nothing claims this is the real thing.
    }
  }

  async sync() {
    const clientSend = Date.now();
    const params = new URLSearchParams({
      readerId: this.readerId,
      displayName: this.displayName,
      clientSendUtc: new Date(clientSend).toISOString(),
    });

    const payload = await this.request(`/api/sync?${params.toString()}`);
    const clientReceive = Date.now();

    const serverReceive = Date.parse(payload.serverReceiveUtc);
    const serverTransmit = Date.parse(payload.serverTransmitUtc);

    if (!Number.isFinite(serverReceive) || !Number.isFinite(serverTransmit)) {
      throw new Error("Timecode master did not return usable sync timestamps.");
    }

    // Standard NTP/Cristian estimate. Round-trip minus the time the server spent holding the
    // request is the time actually spent on the wire; assuming it was split evenly between the two
    // directions, the midpoint of the two one-way estimates is the offset.
    const rtt = (clientReceive - clientSend) - (serverTransmit - serverReceive);
    const offset = ((serverReceive - clientSend) + (serverTransmit - clientReceive)) / 2;

    this.applyMasterMetadata(payload);

    if (this.isRttOutlier(rtt)) {
      // Keep the metadata (frame rate, source status — those are still true) but don't let a
      // badly-queued round trip move the clock.
      return this.status;
    }

    this.rttSamples.push(rtt);
    if (this.rttSamples.length > SAMPLE_WINDOW) this.rttSamples.shift();

    this.offsetMs = offset;
    this.latencyMs = rtt / 2;
    this.lastSyncAt = new Date();

    // Cross-check our arithmetic against the master's own rendering of the same instant. These
    // should agree to well under a frame; a large disagreement means the two machines' local
    // clocks sit in different timezones (or disagree about DST), because the master derives its
    // timecode from local time-of-day rather than UTC and an offset measured in UTC cannot see
    // that. Serving a confidently wrong timecode is worse than admitting the mismatch.
    this.driftFrames = timecodeDifferenceInFrames(
      formatWallClockTimecode(new Date(clientReceive + this.offsetMs), this.frameRate),
      payload.timecode,
      this.frameRate
    );

    return this.status;
  }

  applyMasterMetadata(payload) {
    const frameRate = Number(payload.frameRate);
    if (Number.isFinite(frameRate) && frameRate > 0) this.frameRate = frameRate;
    if (payload.timecodeType) this.timecodeType = payload.timecodeType;
    if (payload.sourceStatus) this.sourceStatus = payload.sourceStatus;
    if (Number.isFinite(Number(payload.connectedReaders))) this.connectedReaders = Number(payload.connectedReaders);
  }

  isRttOutlier(rtt) {
    if (rtt < 0) return true;
    if (this.rttSamples.length < 3) return false;
    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const threshold = Math.max(RTT_OUTLIER_FLOOR_MS, median * RTT_OUTLIER_MULTIPLIER);
    return rtt > threshold;
  }

  // Raw master state for the diagnostics endpoint — the generator's own view rather than ours.
  async masterSnapshot() {
    const [timecode, readers] = await Promise.all([
      this.request("/api/timecode").catch((error) => ({ error: error.message })),
      this.request("/api/readers").catch((error) => ({ error: error.message })),
    ]);
    return { timecode, readers: readers?.readers ?? null };
  }

  async request(path) {
    let response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Unable to reach the timecode generator at ${this.baseUrl}. Is Timecode.Master.exe running in Generator mode? (${error.message})`);
    }

    if (!response.ok) {
      throw new Error(`Timecode generator returned ${response.status}.`);
    }

    return response.json();
  }
}

module.exports = {
  TimecodeMasterService,
  LOCK_STATE,
};
