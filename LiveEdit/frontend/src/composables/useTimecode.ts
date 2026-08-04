/**
 * Timecode conversion helpers shared by the timeline and monitors.
 * All timeline positions are stored internally as frame counts.
 */
export function useTimecode(fps = 29.97) {
  const safeFps = Math.max(1, Math.round(Number.isFinite(fps) ? fps : 29.97));

  function framesToTimecode(frames: number): string {
    const totalFrames = Number.isFinite(frames) ? Math.max(0, Math.round(frames)) : 0;
    const ff = totalFrames % safeFps;
    const totalSeconds = Math.floor(totalFrames / safeFps);
    const ss = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const mm = totalMinutes % 60;
    const hh = Math.floor(totalMinutes / 60);

    return [hh, mm, ss, ff].map((v) => String(v).padStart(2, '0')).join(':');
  }

  function timecodeToFrames(timecode: string): number {
    const parts = timecode.split(':').map((p) => Number.parseInt(p, 10) || 0);
    const [hh = 0, mm = 0, ss = 0, ff = 0] = parts;
    return ((hh * 60 + mm) * 60 + ss) * safeFps + ff;
  }

  function framesToSeconds(frames: number): number {
    return frames / safeFps;
  }

  function secondsToFrames(seconds: number): number {
    return Math.round(seconds * safeFps);
  }

  return { framesToTimecode, timecodeToFrames, framesToSeconds, secondsToFrames };
}
