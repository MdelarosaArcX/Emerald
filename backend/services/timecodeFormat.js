// Shared by server.js (/api/capture/timecode, on-air timecode) and obsIngestService.js
// (RecordingSession/RecordingSegment.startTimecode) so both read the exact same wall-clock
// SMPTE-style HH:MM:SS:FF format from one place.
//
// Note on which clock these read: every function here formats whatever Date it is handed, in
// local time. Callers that need the *generator's* timecode must pass an already-corrected Date
// (see timecodeMasterService.currentDate(), which adds the measured offset to the master).
// The Timecode System master derives its own timecode from its local time-of-day the same way,
// so a corrected Date formatted here reproduces the master's reading exactly.
function formatWallClockTimecode(date, fps) {
  const pad = (value) => String(Math.trunc(value)).padStart(2, "0");
  const frames = Math.floor((date.getMilliseconds() / 1000) * fps);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}:${pad(frames)}`;
}

// Milliseconds elapsed since local midnight. The shared basis for both the frame math above and
// the sample math below, so a timecode and its matching BWF stamp can never disagree about which
// instant "now" is.
function millisecondsSinceMidnight(date) {
  return (
    date.getHours() * 3600000 +
    date.getMinutes() * 60000 +
    date.getSeconds() * 1000 +
    date.getMilliseconds()
  );
}

// Broadcast WAV's bext "time_reference" field: the number of audio samples elapsed since local
// midnight at the start of the file. This is the field an NLE reads to place a standalone WAV on
// the timeline against picture, and it is what makes a separate audio file conform to the .mov
// automatically instead of having to be lined up by hand.
function timeReferenceSamples(date, sampleRate = 48000) {
  return Math.round((millisecondsSinceMidnight(date) / 1000) * sampleRate);
}

// Inverse of formatWallClockTimecode, for reading a stored timecode back (segment reconciliation,
// diffing our computed value against the master's own string). Returns milliseconds since local
// midnight, or null if the string isn't HH:MM:SS:FF.
function parseTimecodeToMilliseconds(timecode, fps) {
  if (typeof timecode !== "string") return null;
  const match = /^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/.exec(timecode.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, frames] = match.map(Number);
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return hours * 3600000 + minutes * 60000 + seconds * 1000 + (frames / fps) * 1000;
}

// Signed distance between two timecodes, in frames, wrapping at midnight so a comparison taken
// either side of 00:00:00:00 reports "1 frame apart" rather than "a whole day apart". Used to
// check our locally computed timecode against the master's, where a large disagreement means the
// two machines' local clocks are in different timezones rather than merely unsynchronized.
function timecodeDifferenceInFrames(a, b, fps) {
  const aMs = parseTimecodeToMilliseconds(a, fps);
  const bMs = parseTimecodeToMilliseconds(b, fps);
  if (aMs === null || bMs === null) return null;
  const DAY_MS = 86400000;
  let deltaMs = aMs - bMs;
  if (deltaMs > DAY_MS / 2) deltaMs -= DAY_MS;
  if (deltaMs < -DAY_MS / 2) deltaMs += DAY_MS;
  return (deltaMs / 1000) * fps;
}

module.exports = {
  formatWallClockTimecode,
  millisecondsSinceMidnight,
  timeReferenceSamples,
  parseTimecodeToMilliseconds,
  timecodeDifferenceInFrames,
};
