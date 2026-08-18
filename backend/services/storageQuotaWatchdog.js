const { parseSizeLimit, getDirectorySize, enforceFolderQuota } = require("./storageQuotaService");
const { logEvent } = require("./eventLogService");

/**
 * Keeps RECORDING_SIZE_LIMIT and STORAGE_SIZE_LIMIT enforced whether or not a recording is
 * running.
 *
 * Both quotas used to be applied only from ObsIngestService.runMaintenance(), which is started in
 * start() and stopped in stop() — so nothing pruned while the system sat idle, and the backup
 * volume's quota was never applied at session start either (only the recordings one was). The
 * observable result was a backup drive holding 432GB against a 200GB limit, 95% full, with the
 * overflow left there indefinitely because the session that produced it had finished.
 *
 * This runs independently on its own timer so a limit means the same thing at all times. It
 * deliberately only evicts whole *finished* session folders: trimming inside the session that is
 * currently recording stays with runMaintenance, which knows which segment ffmpeg still has open
 * and must never delete it.
 */

// Slow on purpose. Enforcement only has to be eventually correct — during a recording the
// existing 5s maintenance tick already handles the fast path, and this exists to catch what that
// leaves behind. A full recursive size scan of both volumes is real I/O, and doing it often would
// compete with the capture pipeline for the same disks.
const DEFAULT_INTERVAL_MS = 60_000;

class StorageQuotaWatchdog {
  /**
   * @param {object} options
   * @param {string} options.recordingsPath  Root governed by RECORDING_SIZE_LIMIT.
   * @param {() => string|null} options.getActiveSessionFolder  Folder to never evict — the
   *   in-progress recording. A function rather than a value because the watchdog outlives any
   *   individual session.
   * @param {() => string|null} options.getBackupDir  Root governed by STORAGE_SIZE_LIMIT, or null
   *   when the backup volume isn't currently present/writable.
   */
  constructor({ recordingsPath, getActiveSessionFolder, getBackupDir, intervalMs } = {}) {
    this.recordingsPath = recordingsPath;
    this.getActiveSessionFolder = getActiveSessionFolder || (() => null);
    this.getBackupDir = getBackupDir || (() => null);
    this.intervalMs = intervalMs || Number(process.env.STORAGE_QUOTA_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
    this.handle = null;
    this.running = false;
  }

  start() {
    if (this.handle) return;
    // A tick immediately at boot, because the most likely moment to be over quota is right after
    // a restart that followed a long session — exactly the case that went unnoticed before.
    this.tick().catch(() => {});
    this.handle = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
    this.handle.unref?.();
  }

  stop() {
    if (!this.handle) return;
    clearInterval(this.handle);
    this.handle = null;
  }

  async tick() {
    // A scan can outlast the interval on a slow or very full volume; overlapping runs would have
    // two passes deleting from the same list and double-counting what they had freed.
    if (this.running) return;
    this.running = true;

    try {
      const activeFolder = this.getActiveSessionFolder();

      // Re-read per tick rather than caching at construction, so editing .env and restarting
      // isn't the only way to change a limit, and so "unlimited" (0/blank) is honoured live.
      const recordingLimit = parseSizeLimit(process.env.RECORDING_SIZE_LIMIT);
      const storageLimit = parseSizeLimit(process.env.STORAGE_SIZE_LIMIT);

      await this.enforce(this.recordingsPath, recordingLimit, activeFolder, "RECORDING_SIZE_LIMIT");

      const backupDir = this.getBackupDir();
      if (backupDir) {
        await this.enforce(backupDir, storageLimit, activeFolder, "STORAGE_SIZE_LIMIT");
      }
    } finally {
      this.running = false;
    }
  }

  async enforce(rootDir, limitBytes, activeFolder, limitName) {
    if (!rootDir || !limitBytes) return;

    const before = await getDirectorySize(rootDir);
    if (before <= limitBytes) return;

    // Report-only unless explicitly armed. Eviction granularity is a whole session folder, so on
    // a volume that has been over its limit for a while the first pass can delete far more than
    // the overage — a single long recording's backup can be hundreds of gigabytes, and taking it
    // to get under the limit means losing all of it at once. Since this watchdog also runs at
    // boot, arming it by default would turn "restart the backend" into an unannounced bulk
    // delete of finished recordings. Operators enable it once they have seen what it intends to
    // remove: set STORAGE_QUOTA_ENFORCE=true.
    if (!isEnforcementArmed()) {
      const preview = await previewEvictions(rootDir, limitBytes, activeFolder);
      logEvent(
        `${limitName}: ${toGb(before)}GB exceeds the ${toGb(limitBytes)}GB limit. Enforcement is OFF `
        + `(set STORAGE_QUOTA_ENFORCE=true to arm it). Would evict: ${preview.length ? preview.join(", ") : "nothing evictable"}.`,
        "warn",
        "Storage",
      );
      return;
    }

    await enforceFolderQuota(rootDir, limitBytes, activeFolder);
    const after = await getDirectorySize(rootDir);

    const freed = before - after;
    if (freed <= 0) {
      // Over the limit with nothing evictable — everything left is either the active session or
      // failed to delete. Worth an operator-visible warning rather than silence, because this is
      // the state that eventually fills the volume.
      logEvent(
        `${limitName}: ${toGb(rootDir === this.recordingsPath ? after : after)}GB exceeds the ${toGb(limitBytes)}GB limit but nothing could be evicted`
        + `${activeFolder ? ` (all remaining data belongs to the active session '${activeFolder}')` : ""}.`,
        "warn",
        "Storage",
      );
      return;
    }

    logEvent(
      `${limitName}: evicted ${toGb(freed)}GB from ${rootDir} — now ${toGb(after)}GB against a ${toGb(limitBytes)}GB limit.`,
      "info",
      "Storage",
    );
  }
}

function toGb(bytes) {
  return (bytes / 1024 ** 3).toFixed(1);
}

function isEnforcementArmed() {
  return String(process.env.STORAGE_QUOTA_ENFORCE || "").trim().toLowerCase() === "true";
}

/**
 * Names and sizes this pass would delete, without deleting anything — deliberately mirroring
 * enforceFolderQuota's own selection (oldest first, skipping the active session) so the warning
 * describes what would really happen rather than an approximation of it.
 */
async function previewEvictions(rootDir, limitBytes, activeFolder) {
  const fs = require("node:fs");
  const path = require("node:path");

  let entries;
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const folders = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const folderPath = path.join(rootDir, entry.name);
        const [size, stat] = await Promise.all([
          getDirectorySize(folderPath),
          fs.promises.stat(folderPath).catch(() => null),
        ]);
        return { name: entry.name, size, createdAt: stat?.birthtimeMs ?? 0 };
      }),
  );

  let total = folders.reduce((sum, folder) => sum + folder.size, 0);
  const planned = [];

  for (const folder of folders.filter((f) => f.name !== activeFolder).sort((a, b) => a.createdAt - b.createdAt)) {
    if (total <= limitBytes) break;
    planned.push(`${folder.name} (${toGb(folder.size)}GB)`);
    total -= folder.size;
  }

  return planned;
}

module.exports = {
  StorageQuotaWatchdog,
};
