/**
 * Timecode conversion helpers shared by the timeline and monitors.
 * All timeline positions are stored internally as frame counts.
 *
 * These read as LOCAL TIME OF DAY, not elapsed time: frame 0 is local midnight (see
 * startOfDayMs/appendCaptureSegment in timelineStore), so a frame count converts straight to a
 * wall-clock HH:MM:SS:FF with no session offset to apply.
 *
 * Emerald captures 25 fps, so the frame field runs 00..24 and the rate is a whole number — the
 * timebase divides exactly. That matters more than it looks: positions are laid down as
 * secondsSinceMidnight * fps but rendered back through Math.round(fps), so a fractional rate (the
 * previous 29.97 default) placed frames on one timebase and read them on another. The clock drifted
 * by that 0.1% — roughly 3.6s per hour, over a minute adrift by late evening.
 *
 * Takes either a fixed rate or a getter. Prefer the getter (`() => timelineStore.fps`) from
 * anything whose rate can change after setup: the editor's timeline arrives from an async
 * fetchTimeline(), so a plain number captured during setup is read *before* that resolves and then
 * never updates. Resolving per call instead means the rate is read inside the caller's computed,
 * which both keeps it current and registers the reactive dependency.
 */
export function useTimecode(fps: number | (() => number) = 25) {
  function resolveFps(): number {
    const value = typeof fps === 'function' ? fps() : fps;
    return Math.max(1, Math.round(Number.isFinite(value) ? value : 25));
  }

  /** Frame count -> local time of day, HH:MM:SS:FF (frames 00..24 at 25 fps). */
  function framesToTimecode(frames: number): string {
    const safeFps = resolveFps();
    const totalFrames = Math.max(0, Math.round(frames));
    const ff = totalFrames % safeFps;
    const totalSeconds = Math.floor(totalFrames / safeFps);
    const ss = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const mm = totalMinutes % 60;
    // Wrap at 24h so this stays a clock reading. A live session recording through local midnight
    // keeps accumulating frames past 24:00:00:00, which is not a time of day.
    const hh = Math.floor(totalMinutes / 60) % 24;

    return [hh, mm, ss, ff].map((v) => String(v).padStart(2, '0')).join(':');
  }

  function timecodeToFrames(timecode: string): number {
    const parts = timecode.split(':').map((p) => Number.parseInt(p, 10) || 0);
    const [hh = 0, mm = 0, ss = 0, ff = 0] = parts;
    return ((hh * 60 + mm) * 60 + ss) * resolveFps() + ff;
  }

  function framesToSeconds(frames: number): number {
    return frames / resolveFps();
  }

  function secondsToFrames(seconds: number): number {
    return Math.round(seconds * resolveFps());
  }

  return { framesToTimecode, timecodeToFrames, framesToSeconds, secondsToFrames };
}
