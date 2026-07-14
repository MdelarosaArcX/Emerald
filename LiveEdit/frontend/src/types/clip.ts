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
