/** Track type discriminator for timeline tracks. */
export type TrackKind = 'video' | 'audio' | 'fx';

/** Supported clip media types. */
export type ClipType = 'video' | 'audio' | 'image' | 'title' | 'fx';

/** A single applied effect on a clip. */
export interface ClipEffect {
  id: string;
  name: string;
  enabled: boolean;
  params: Record<string, number | string | boolean>;
}

/** A clip placed on a timeline track. All time values are in frames. */
export interface Clip {
  id: string;
  name: string;
  path: string;
  track: string;
  start: number;
  duration: number;
  trimIn: number;
  trimOut: number;
  color: string;
  effects: ClipEffect[];
  type: ClipType;
  opacity?: number;
  rotation?: number;
  scale?: number;
  position?: { x: number; y: number };
  speed?: number;
  volume?: number;
  locked?: boolean;
  thumbnail?: string;
  waveform?: number[];
  /**
   * True for material that arrived from the live edit-capture recorder rather than being placed by
   * hand. Splitting or trimming such a clip keeps the flag, since the pieces are still live
   * material — it describes where the footage came from, not how it has been edited since.
   */
  live?: boolean;
  /**
   * Stable identity of the captured segment this clip came from, as `folder/fileName`.
   *
   * Exists because a segment reaches the timeline by two routes that name the same file
   * differently: the socket feed carries the LiveEdit backend's generated proxy URL, while the
   * backfill poll carries Emerald's own recordings URL. Deduplicating on `path` therefore never
   * matched across the two, and every automatically-added segment landed twice — once from each
   * route, the socket copy without a thumbnail because that payload has none. This is the one
   * value both routes agree on.
   *
   * Survives splitting and trimming, like `live`: the pieces are still that same source segment,
   * and the backfill must not re-add a segment just because it has since been cut up.
   */
  sourceKey?: string;
}

/** A timeline track (video, audio, or fx lane). */
export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  order: number;
  height: number;
  locked: boolean;
  visible: boolean;
  muted: boolean;
  solo: boolean;
  clips: Clip[];
}

/** The full timeline document. */
export interface Timeline {
  id: string;
  fps: number;
  duration: number;
  tracks: Track[];
  playhead: number;
}
