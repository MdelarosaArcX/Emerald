/**
 * Connection / recording / playback status surfaced to the frontend toolbar.
 */
export interface SystemStatus {
  connected: boolean;
  recording: boolean;
  playing: boolean;
  cpuUsage: number;
  memoryUsage: number;
  fps: number;
  networkQuality: 'excellent' | 'good' | 'poor' | 'offline';
  delayMs: number;
}

/**
 * Media asset available in the Media Browser / Project Sidebar.
 */
export interface MediaAsset {
  id: string;
  name: string;
  path: string;
  type: 'video' | 'audio' | 'image';
  duration: number;
  fps: number;
  resolution: string;
  codec: string;
  bitrate: string;
  sizeBytes: number;
  thumbnail?: string;
  createdAt: string;
}

/**
 * Capture device / session metadata for the Capture Preview panel.
 */
export interface CaptureInfo {
  localPath: string;
  title: string;
  description: string;
  duration: number;
  fps: number;
  resolution: string;
  codec: string;
  bitrate: string;
  isCapturing: boolean;
}

/**
 * Currently playing clip metadata for the Live Playback panel.
 */
export interface PlaybackInfo {
  clipId: string | null;
  filePath: string;
  duration: number;
  fps: number;
  resolution: string;
  codec: string;
  audioChannels: number;
  currentTime: number;
  isPlaying: boolean;
  volume: number;
  speed: number;
}

/**
 * Top-level project descriptor.
 */
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  fps: number;
  resolution: string;
  timelineId: string;
  mediaAssets: MediaAsset[];
}
