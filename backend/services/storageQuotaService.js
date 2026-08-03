const fs = require("node:fs");
const path = require("node:path");

const UNIT_MULTIPLIERS = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
};

// "0", blank, or unparsable input means unlimited (returns 0).
function parseSizeLimit(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return 0;

  const match = /^([\d.]+)\s*(b|kb|mb|gb|tb)?$/i.exec(value);
  if (!match) return 0;

  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return 0;

  const unit = (match[2] || "b").toLowerCase();
  return Math.round(number * UNIT_MULTIPLIERS[unit]);
}

async function getDirectorySize(dirPath) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySize(entryPath);
    } else {
      try {
        total += (await fs.promises.stat(entryPath)).size;
      } catch {
        // File may have been removed/rotated mid-scan — ignore.
      }
    }
  }

  return total;
}

// Deletes whole session subfolders of `rootDir`, oldest first, until the total size of
// its non-dot subfolders is back under `limitBytes`. Never deletes `excludeFolderName`
// (the in-progress recording session). No-op when `limitBytes` is 0 (unlimited).
async function enforceFolderQuota(rootDir, limitBytes, excludeFolderName) {
  if (!limitBytes) return;

  let entries;
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  const folderNames = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);

  const folders = await Promise.all(folderNames.map(async (name) => {
    const folderPath = path.join(rootDir, name);
    const [size, stat] = await Promise.all([
      getDirectorySize(folderPath),
      fs.promises.stat(folderPath).catch(() => null),
    ]);

    return { name, path: folderPath, size, createdAt: stat?.birthtimeMs ?? 0 };
  }));

  let total = folders.reduce((sum, folder) => sum + folder.size, 0);
  if (total <= limitBytes) return;

  const evictable = folders
    .filter((folder) => folder.name !== excludeFolderName)
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const folder of evictable) {
    if (total <= limitBytes) break;

    try {
      await fs.promises.rm(folder.path, { recursive: true, force: true });
      total -= folder.size;
    } catch {
      // Folder may be locked/in use — skip and try the next oldest.
    }
  }
}

// Trims the oldest *already-finished* segments of the currently-recording session itself, once
// evicting other finished sessions alone isn't enough to get back under the limit — the active
// session is never stopped (per the operator's requirement that recording must keep running no
// matter what), so if it's the only thing left, or it's simply growing faster than old sessions
// can be freed, its own oldest footage has to give way instead. The highest segment index across
// all three output types (archival .mov, playback .mp4, HLS .ts) is presumed still being actively
// written by FFmpeg and is never touched, even if the folder is still over quota afterward.
async function trimActiveSessionSegments(sessionDir, limitBytes, currentTotalBytes) {
  if (!limitBytes || currentTotalBytes <= limitBytes) return currentTotalBytes;

  let files;
  try {
    files = await fs.promises.readdir(sessionDir);
  } catch {
    return currentTotalBytes;
  }

  const patterns = [/^emerald-(\d+)\.mov$/i, /^emerald-(\d+)\.mp4$/i, /^emerald-tx-(\d+)\.ts$/i];

  // Groups filenames by segment index across all three output types, so a given index's
  // mov/mp4/ts trio is always evicted together — never leaves one output type's file for an
  // index sitting around after the other two have already been deleted for it.
  const byIndex = new Map();
  for (const fileName of files) {
    for (const pattern of patterns) {
      const match = pattern.exec(fileName);
      if (match) {
        const index = Number(match[1]);
        if (!byIndex.has(index)) byIndex.set(index, []);
        byIndex.get(index).push(fileName);
        break;
      }
    }
  }

  const indexes = [...byIndex.keys()].sort((a, b) => a - b);
  const currentIndex = indexes[indexes.length - 1];

  let total = currentTotalBytes;
  for (const index of indexes) {
    if (index === currentIndex || total <= limitBytes) break;

    for (const fileName of byIndex.get(index)) {
      const filePath = path.join(sessionDir, fileName);
      try {
        const stat = await fs.promises.stat(filePath);
        await fs.promises.rm(filePath, { force: true });
        total -= stat.size;
      } catch {
        // Already gone or locked — move on to the next file/index.
      }
    }
  }

  return total;
}

// Single-file-type variant of trimActiveSessionSegments, for pipelines where a paired file (e.g.
// a small browser-playable proxy alongside a large master) must never be evicted just because its
// master was. Trims the oldest already-finished files matching `filePattern` in `sessionDir`,
// oldest index first, until back under `limitBytes` — the highest-index match is presumed still
// being actively written and is never touched.
async function trimOldestSegmentFiles(sessionDir, limitBytes, currentTotalBytes, filePattern) {
  if (!limitBytes || currentTotalBytes <= limitBytes) return currentTotalBytes;

  let files;
  try {
    files = await fs.promises.readdir(sessionDir);
  } catch {
    return currentTotalBytes;
  }

  const matches = files
    .map((fileName) => {
      const match = filePattern.exec(fileName);
      return match ? { fileName, index: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);

  if (matches.length === 0) return currentTotalBytes;
  const currentIndex = matches[matches.length - 1].index;

  let total = currentTotalBytes;
  for (const { fileName, index } of matches) {
    if (index === currentIndex || total <= limitBytes) break;

    const filePath = path.join(sessionDir, fileName);
    try {
      const stat = await fs.promises.stat(filePath);
      await fs.promises.rm(filePath, { force: true });
      total -= stat.size;
    } catch {
      // Already gone or locked — move on to the next file.
    }
  }

  return total;
}

module.exports = {
  parseSizeLimit,
  getDirectorySize,
  enforceFolderQuota,
  trimActiveSessionSegments,
  trimOldestSegmentFiles,
};
