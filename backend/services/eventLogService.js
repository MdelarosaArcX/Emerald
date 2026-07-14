const fs = require("node:fs");
const path = require("node:path");

// Human-readable, append-only record of significant events (recording started, on-air started,
// etc.) with the wall-clock timecode at that moment — distinct from timecodeLogService.js's
// continuous per-second JSON sampling of ongoing health/delay. This one's for "when did I
// actually hit record" / "when did on-air actually start", read by a person, not polled by code.
const LOG_PATH = path.join(__dirname, "..", "logs", "logs.txt");

function formatWallClockTimecode(date, fps = 25) {
  const pad = (value) => String(Math.trunc(value)).padStart(2, "0");
  const frames = Math.floor((date.getMilliseconds() / 1000) * fps);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}:${pad(frames)}`;
}

function logEvent(message) {
  const now = new Date();
  const line = `[${now.toISOString()}] [tc ${formatWallClockTimecode(now)}] ${message}\n`;

  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line, "utf8");
  } catch (error) {
    console.error("Unable to write event log:", error.message);
  }

  console.log(`[event] ${line.trim()}`);
}

module.exports = {
  logEvent,
  formatWallClockTimecode,
};
