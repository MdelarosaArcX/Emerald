const fs = require("node:fs");
const path = require("node:path");

// Human-readable, append-only record of significant events (recording started, on-air started,
// etc.) with the wall-clock timecode at that moment — distinct from timecodeLogService.js's
// continuous per-second JSON sampling of ongoing health/delay. This one's for "when did I
// actually hit record" / "when did on-air actually start", read by a person, not polled by code.
// Where both this log and timecodeLogService.js's timecode.log are written. EMERALD_LOG_PATH exists
// because the packaged suite installs the backend under Program Files, which is read-only for a
// standard user — writing beside the code there fails with EPERM. Unset (the development checkout),
// it stays in backend/logs exactly as before.
const LOG_DIR = process.env.EMERALD_LOG_PATH
  ? path.resolve(process.env.EMERALD_LOG_PATH)
  : path.join(__dirname, "..", "logs");
const LOG_PATH = path.join(LOG_DIR, "logs.txt");

function formatWallClockTimecode(date, fps = 25) {
  const pad = (value) => String(Math.trunc(value)).padStart(2, "0");
  const frames = Math.floor((date.getMilliseconds() / 1000) * fps);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}:${pad(frames)}`;
}

const LEVELS = new Set(["info", "warn", "error"]);

// source groups log lines by where they came from (Recorder, FileWriter, Audio, DeltaRX{n}, TX,
// System, ...) — shown as its own column in the Capture page's Capture Logs tab.
function logEvent(message, level = "info", source = "System") {
  const normalizedLevel = LEVELS.has(level) ? level : "info";
  const now = new Date();
  const line = `[${now.toISOString()}] [${normalizedLevel.toUpperCase()}] [tc ${formatWallClockTimecode(now)}] [${source}] ${message}\n`;

  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line, "utf8");
  } catch (error) {
    console.error("Unable to write event log:", error.message);
  }

  console.log(`[event] ${line.trim()}`);
}

// Parses logs.txt back into structured rows for the frontend's Capture Logs tab. Tolerates lines
// written before the [LEVEL]/[SOURCE] tags existed (defaults to "info"/"System") so old log
// history still renders.
const LOG_LINE_PATTERN = /^\[(.+?)\] \[(INFO|WARN|ERROR)\] \[tc (.+?)\] \[(.+?)\] (.*)$/;
const PRE_SOURCE_LOG_LINE_PATTERN = /^\[(.+?)\] \[(INFO|WARN|ERROR)\] \[tc (.+?)\] (.*)$/;
const LEGACY_LOG_LINE_PATTERN = /^\[(.+?)\] \[tc (.+?)\] (.*)$/;

function readRecentEvents(limit = 200) {
  let contents;
  try {
    contents = fs.readFileSync(LOG_PATH, "utf8");
  } catch (error) {
    return [];
  }

  const lines = contents.split("\n").filter((line) => line.trim().length > 0);
  const recentLines = lines.slice(-Math.max(1, limit));

  return recentLines.map((line, index) => {
    const match = LOG_LINE_PATTERN.exec(line);
    if (match) {
      const [, timestamp, level, tc, source, message] = match;
      return { id: index, timestamp, level: level.toLowerCase(), tc, source, message };
    }

    const preSourceMatch = PRE_SOURCE_LOG_LINE_PATTERN.exec(line);
    if (preSourceMatch) {
      const [, timestamp, level, tc, message] = preSourceMatch;
      return { id: index, timestamp, level: level.toLowerCase(), tc, source: "System", message };
    }

    const legacyMatch = LEGACY_LOG_LINE_PATTERN.exec(line);
    if (legacyMatch) {
      const [, timestamp, tc, message] = legacyMatch;
      return { id: index, timestamp, level: "info", tc, source: "System", message };
    }

    return { id: index, timestamp: null, level: "info", tc: null, source: "System", message: line };
  });
}

module.exports = {
  logEvent,
  readRecentEvents,
  formatWallClockTimecode,
  LOG_DIR,
};
