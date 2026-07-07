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

module.exports = {
  parseSizeLimit,
  getDirectorySize,
  enforceFolderQuota,
};
