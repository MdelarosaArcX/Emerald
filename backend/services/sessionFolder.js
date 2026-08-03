const fs = require("node:fs");
const path = require("node:path");

// Folder name is `${prefix}` + local time as MMDDYYYYHHmm (e.g. 4:31 AM on 2026-03-07 with
// prefix "emerald" -> "emerald030720260431"). Local time, not UTC, since it's meant to read as a
// wall-clock timestamp for whoever is browsing the recordings folder.
function formatSessionFolderName(prefix, date) {
  const pad = (value, length = 2) => String(value).padStart(length, "0");

  return `${prefix}${pad(date.getMonth() + 1)}${pad(date.getDate())}${date.getFullYear()}`
    + `${pad(date.getHours())}${pad(date.getMinutes())}`;
}

// Same-minute restarts would otherwise collide on one folder name — suffix with -2, -3, ...
function createSessionFolder(rootDir, prefix, date) {
  const baseName = formatSessionFolderName(prefix, date);
  let folderName = baseName;
  let suffix = 2;

  while (fs.existsSync(path.join(rootDir, folderName))) {
    folderName = `${baseName}-${suffix}`;
    suffix += 1;
  }

  fs.mkdirSync(path.join(rootDir, folderName), { recursive: true });
  return folderName;
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

module.exports = {
  formatSessionFolderName,
  createSessionFolder,
  clamp,
};
