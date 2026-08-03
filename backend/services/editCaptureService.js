const fs = require("node:fs");
const path = require("node:path");
const { createSessionFolder, clamp } = require("./sessionFolder");
const { parseSizeLimit, getDirectorySize, enforceFolderQuota, trimOldestSegmentFiles } = require("./storageQuotaService");
const { formatWallClockTimecode } = require("./timecodeFormat");
const { probeSegment } = require("./segmentProbeService");
const db = require("../db");

const MAINTENANCE_INTERVAL_MS = 5000;
const MASTER_PATTERN = /^editcapture-(\d+)\.mov$/;

// Hybrid of the two existing patterns, because responsibility genuinely splits differently here
// than either precedent:
//  - Control (start/stop/status) is a thin proxy to DeltacastCaptureService, exactly like
//    deltacastTxService.js — C# owns the ffmpeg process since it's the only thing with access to
//    FrameQueueService.
//  - Reconciliation/quota is an independent Node-owned setTimeout-chained maintenance loop, like
//    obsIngestService.scheduleMaintenance() (never setInterval — the same overlap-prevention
//    reasoning applies even more strongly here given a single tick's filesystem work now scanning
//    multi-GB files).
class EditCaptureService {
  constructor(editCapturePath, options = {}) {
    this.editCapturePath = editCapturePath;
    this.baseUrl = (options.baseUrl || process.env.DELTACAST_TX_SERVICE_URL || "http://127.0.0.1:5055").replace(/\/+$/, "");
    this.editCaptureSizeLimitBytes = parseSizeLimit(process.env.EDIT_CAPTURE_SIZE_LIMIT);
    this.proxyBitrateKbps = Number(process.env.EDIT_CAPTURE_PROXY_BITRATE_KBPS) || 4000;

    this.sessionFolderName = null;
    this.dbSessionId = null;
    this.dbKnownSegments = new Set();
    this.dbFrameRate = 25;
    this.segmentSeconds = 120;

    this.maintenanceHandle = null;
    this.maintenanceStopped = true;
  }

  async start(request = {}) {
    const currentStatus = await this.status().catch(() => null);
    if (currentStatus?.isCapturing) {
      return currentStatus;
    }

    const segmentSeconds = clamp(Number(request.segmentSeconds || 120), 10, 3600);
    const enableAudio = request.enableAudio !== false;
    const sessionFolderName = createSessionFolder(this.editCapturePath, "editcapture", new Date());
    const outputDirectory = path.join(this.editCapturePath, sessionFolderName);

    const status = await this.request("POST", "/edit-capture/start", { outputDirectory, segmentSeconds, enableAudio });

    this.sessionFolderName = sessionFolderName;
    this.dbSessionId = null;
    this.dbKnownSegments = new Set();
    this.segmentSeconds = segmentSeconds;

    db.recordEditCaptureSessionStart({
      folderName: sessionFolderName,
      startedAt: new Date(),
      startTimecode: formatWallClockTimecode(new Date(), this.dbFrameRate),
      frameRate: this.dbFrameRate,
      segmentSeconds,
      videoCodec: "rawvideo",
      pixelFormat: "uyvy422",
      videoWidth: 1920,
      videoHeight: 1080,
      audioCodec: enableAudio ? "pcm_s16le" : null,
      proxyVideoCodec: "h264",
      proxyBitrateKbps: this.proxyBitrateKbps,
    })
      .then((session) => { this.dbSessionId = session.id; })
      .catch((error) => console.error("Unable to record edit-capture session in database:", error.message));

    this.maintenanceStopped = false;
    this.scheduleMaintenance();

    return { ...status, sessionFolderName };
  }

  async stop() {
    const status = await this.request("POST", "/edit-capture/stop");

    this.maintenanceStopped = true;
    if (this.maintenanceHandle) {
      clearTimeout(this.maintenanceHandle);
      this.maintenanceHandle = null;
    }
    // One final pass so the last segment (and any master trimmed while catching up on quota) is
    // reconciled even after the operator has already clicked Stop.
    await this.runMaintenance().catch(() => {});

    if (this.sessionFolderName) {
      await db.recordEditCaptureSessionStop(this.sessionFolderName, {
        stoppedAt: new Date(),
        status: "stopped",
      }).catch((error) => console.error("Unable to record edit-capture session stop in database:", error.message));
    }

    return { ...status, sessionFolderName: this.sessionFolderName };
  }

  // Includes sessionFolderName so LiveEdit's backend (and any other consumer) can look up
  // segments for the active session without maintaining its own duplicate session-tracking state.
  async status() {
    const status = await this.request("GET", "/edit-capture/status");
    return { ...status, sessionFolderName: this.sessionFolderName };
  }

  scheduleMaintenance() {
    this.maintenanceHandle = setTimeout(async () => {
      if (this.maintenanceStopped) return;

      try {
        await this.runMaintenance();
      } finally {
        if (!this.maintenanceStopped) {
          this.scheduleMaintenance();
        }
      }
    }, MAINTENANCE_INTERVAL_MS);
    this.maintenanceHandle.unref?.();
  }

  async runMaintenance() {
    await this.reconcileSegments();

    if (!this.editCaptureSizeLimitBytes || !this.sessionFolderName) return;

    await enforceFolderQuota(this.editCapturePath, this.editCaptureSizeLimitBytes, this.sessionFolderName);

    const totalBytes = await getDirectorySize(this.editCapturePath);
    if (totalBytes > this.editCaptureSizeLimitBytes) {
      const sessionDir = path.join(this.editCapturePath, this.sessionFolderName);
      // Only ever evicts the uncompressed .mov master, never the paired proxy .mp4 — the proxy is
      // cheap (~60MB/segment) and still useful for review even once its master has been trimmed
      // for space.
      await trimOldestSegmentFiles(sessionDir, this.editCaptureSizeLimitBytes, totalBytes, MASTER_PATTERN);
    }
  }

  // Records any editcapture-NNN.mov segment that's actually finished (the highest index is
  // presumed still being written, unless the C# service reports it's no longer capturing) and
  // isn't in the database yet — a plain size/filename row immediately, then ffprobes the master
  // in the background to fill in verified codec/duration once it completes.
  async reconcileSegments() {
    if (!this.dbSessionId || !this.sessionFolderName) return;

    const sessionDir = path.join(this.editCapturePath, this.sessionFolderName);
    let files;
    try {
      files = await fs.promises.readdir(sessionDir);
    } catch {
      return;
    }

    const segments = files
      .map((fileName) => {
        const match = MASTER_PATTERN.exec(fileName);
        return match ? { fileName, index: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);

    if (segments.length === 0) return;

    const liveStatus = await this.request("GET", "/edit-capture/status").catch(() => null);
    const stillCapturing = Boolean(liveStatus?.isCapturing);
    const finishedSegments = stillCapturing ? segments.slice(0, -1) : segments;
    if (finishedSegments.length === 0) return;

    for (const segment of finishedSegments) {
      if (this.dbKnownSegments.has(segment.index)) continue;

      const movPath = path.join(sessionDir, segment.fileName);
      const proxyFileName = segment.fileName.replace(MASTER_PATTERN, "editcapture-proxy-$1.mp4");
      const proxyPath = path.join(sessionDir, proxyFileName);

      let movStat;
      try {
        movStat = await fs.promises.stat(movPath);
      } catch {
        continue;
      }

      let proxySize = null;
      try {
        proxySize = (await fs.promises.stat(proxyPath)).size;
      } catch {
        // proxy leg can finish a beat later than the master — picked up on a later tick.
      }

      // Derived from the segment file's own birthtime, not sessionStart + index*segmentSeconds
      // arithmetic — -use_wallclock_as_timestamps on the C# side is specifically what keeps
      // segment boundaries tracking true elapsed wall-clock time even under upstream frame
      // drops, and arithmetic reconstruction here would throw that away.
      const startTimecode = formatWallClockTimecode(movStat.birthtime, this.dbFrameRate);

      let saved;
      try {
        saved = await db.upsertEditCaptureSegment(this.dbSessionId, {
          segmentIndex: segment.index,
          fileName: segment.fileName,
          sizeBytes: movStat.size,
          proxyFileName,
          proxySizeBytes: proxySize,
          startTimecode,
          createdAt: movStat.birthtime,
        });
      } catch (error) {
        console.error(`Unable to record edit-capture segment '${segment.fileName}' in database:`, error.message);
        continue;
      }

      this.dbKnownSegments.add(segment.index);

      probeSegment(movPath)
        .then((probed) => db.updateEditCaptureSegmentProbe(saved.id, probed))
        .catch((error) => console.error(`Unable to probe edit-capture segment '${segment.fileName}':`, error.message));
    }
  }

  async request(method, requestPath, body) {
    let response;

    try {
      response = await fetch(`${this.baseUrl}${requestPath}`, {
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
  EditCaptureService,
  MASTER_PATTERN,
};
