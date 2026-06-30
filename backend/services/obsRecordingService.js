const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const staticFfmpegPath = require("ffmpeg-static");

function normalizeFfmpegPath(configuredPath) {
  const rawPath = !configuredPath || !String(configuredPath).trim() || String(configuredPath).trim().toLowerCase() === "ffmpeg"
    ? process.env.FFMPEG_PATH || staticFfmpegPath || configuredPath || "ffmpeg"
    : configuredPath;
  const trimmedPath = String(rawPath).trim().replace(/^"|"$/g, "");

  if (fs.existsSync(trimmedPath) && fs.statSync(trimmedPath).isDirectory()) {
    return path.join(trimmedPath, os.platform() === "win32" ? "ffmpeg.exe" : "ffmpeg");
  }

  return trimmedPath;
}

module.exports = {
  normalizeFfmpegPath,
};
