// Shared by server.js (/api/capture/timecode, on-air timecode) and obsIngestService.js
// (RecordingSession/RecordingSegment.startTimecode) so both read the exact same wall-clock
// SMPTE-style HH:MM:SS:FF format from one place.
function formatWallClockTimecode(date, fps) {
  const pad = (value) => String(Math.trunc(value)).padStart(2, "0");
  const frames = Math.floor((date.getMilliseconds() / 1000) * fps);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}:${pad(frames)}`;
}

module.exports = {
  formatWallClockTimecode,
};
