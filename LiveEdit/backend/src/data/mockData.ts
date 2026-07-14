import { v4 as uuid } from 'uuid';
import { Clip, Timeline, Track } from '../types/clip';
import { CaptureInfo, MediaAsset, PlaybackInfo, Project, SystemStatus } from '../types/project';

/**
 * In-memory data store standing in for a persistence layer.
 * Replace with a database / real capture-render pipeline later.
 */

const now = new Date().toISOString();

function makeClip(partial: Partial<Clip> & Pick<Clip, 'id' | 'name' | 'track' | 'start' | 'duration' | 'color' | 'type'>): Clip {
  return {
    path: `/media/${partial.name.toLowerCase().replace(/\s+/g, '-')}.mp4`,
    trimIn: 0,
    trimOut: partial.duration,
    effects: [],
    opacity: 100,
    rotation: 0,
    scale: 100,
    position: { x: 0, y: 0 },
    speed: 1,
    volume: 100,
    locked: false,
    ...partial,
  };
}

const videoTracks: Track[] = [
  {
    id: 'v4', name: 'V4', kind: 'video', order: 0, height: 64, locked: false, visible: true, muted: false, solo: false,
    clips: [],
  },
  {
    id: 'v3', name: 'V3', kind: 'video', order: 1, height: 64, locked: false, visible: true, muted: false, solo: false,
    clips: [
      makeClip({ id: uuid(), name: 'Lower Third - Score', track: 'v3', start: 320, duration: 180, color: '#22d3ee', type: 'title' }),
    ],
  },
  {
    id: 'v2', name: 'V2', kind: 'video', order: 2, height: 64, locked: false, visible: true, muted: false, solo: false,
    clips: [
      makeClip({ id: uuid(), name: 'Sponsor Bug', track: 'v2', start: 0, duration: 900, color: '#10b981', type: 'title' }),
    ],
  },
  {
    id: 'v1', name: 'V1', kind: 'video', order: 3, height: 80, locked: false, visible: true, muted: false, solo: false,
    clips: [
      makeClip({ id: uuid(), name: 'Cam 1 - Wide', track: 'v1', start: 0, duration: 260, color: '#14b8a6', type: 'video' }),
      makeClip({ id: uuid(), name: 'Cam 2 - Close', track: 'v1', start: 260, duration: 220, color: '#0ea5e9', type: 'video' }),
      makeClip({ id: uuid(), name: 'Replay - Goal', track: 'v1', start: 480, duration: 140, color: '#f59e0b', type: 'video' }),
      makeClip({ id: uuid(), name: 'Cam 1 - Wide', track: 'v1', start: 620, duration: 380, color: '#14b8a6', type: 'video' }),
    ],
  },
  {
    id: 'fx', name: 'FX', kind: 'fx', order: 4, height: 48, locked: false, visible: true, muted: false, solo: false,
    clips: [
      makeClip({ id: uuid(), name: 'Cross Dissolve', track: 'fx', start: 250, duration: 20, color: '#a855f7', type: 'fx' }),
    ],
  },
];

const audioTracks: Track[] = [
  {
    id: 'a1', name: 'A1', kind: 'audio', order: 5, height: 56, locked: false, visible: true, muted: false, solo: false,
    clips: [
      makeClip({ id: uuid(), name: 'Commentary Mix', track: 'a1', start: 0, duration: 1000, color: '#34d399', type: 'audio' }),
    ],
  },
  {
    id: 'a2', name: 'A2', kind: 'audio', order: 6, height: 56, locked: false, visible: true, muted: false, solo: false,
    clips: [
      makeClip({ id: uuid(), name: 'Stadium Ambience', track: 'a2', start: 0, duration: 1000, color: '#2dd4bf', type: 'audio' }),
    ],
  },
  {
    id: 'a3', name: 'A3', kind: 'audio', order: 7, height: 56, locked: false, visible: true, muted: false, solo: false, clips: [],
  },
  {
    id: 'a4', name: 'A4', kind: 'audio', order: 8, height: 56, locked: false, visible: true, muted: false, solo: false, clips: [],
  },
];

export const timeline: Timeline = {
  id: 'timeline-main',
  fps: 29.97,
  duration: 1000,
  tracks: [...videoTracks, ...audioTracks],
  playhead: 0,
};

export const mediaAssets: MediaAsset[] = [
  { id: uuid(), name: 'Cam1_Wide_001.mov', path: '/media/cam1-wide-001.mov', type: 'video', duration: 260, fps: 59.94, resolution: '1920x1080', codec: 'ProRes 422', bitrate: '220 Mbps', sizeBytes: 5_400_000_000, createdAt: now },
  { id: uuid(), name: 'Cam2_Close_002.mov', path: '/media/cam2-close-002.mov', type: 'video', duration: 220, fps: 59.94, resolution: '1920x1080', codec: 'ProRes 422', bitrate: '220 Mbps', sizeBytes: 4_800_000_000, createdAt: now },
  { id: uuid(), name: 'Replay_Goal_003.mov', path: '/media/replay-goal-003.mov', type: 'video', duration: 140, fps: 59.94, resolution: '1920x1080', codec: 'ProRes 422', bitrate: '220 Mbps', sizeBytes: 2_900_000_000, createdAt: now },
  { id: uuid(), name: 'Commentary_Mix.wav', path: '/media/commentary-mix.wav', type: 'audio', duration: 1000, fps: 0, resolution: '-', codec: 'PCM 24bit', bitrate: '2.3 Mbps', sizeBytes: 320_000_000, createdAt: now },
  { id: uuid(), name: 'Sponsor_Bug.png', path: '/media/sponsor-bug.png', type: 'image', duration: 0, fps: 0, resolution: '512x256', codec: 'PNG', bitrate: '-', sizeBytes: 400_000, createdAt: now },
];

export const project: Project = {
  id: 'project-emerald-01',
  name: 'Emerald Live Edit',
  createdAt: now,
  updatedAt: now,
  fps: 29.97,
  resolution: '1920x1080',
  timelineId: timeline.id,
  mediaAssets,
};

export const captureInfo: CaptureInfo = {
  localPath: 'C:\\EmeraldCaptures\\match_2026_07_13',
  title: 'Matchday Broadcast - Live Feed',
  description: 'Primary ingest from Cam 1, stadium feed.',
  duration: 0,
  fps: 59.94,
  resolution: '1920x1080',
  codec: 'H.264',
  bitrate: '50 Mbps',
  isCapturing: false,
};

export const playbackInfo: PlaybackInfo = {
  clipId: null,
  filePath: '/media/cam1-wide-001.mov',
  duration: 260,
  fps: 59.94,
  resolution: '1920x1080',
  codec: 'ProRes 422',
  audioChannels: 2,
  currentTime: 0,
  isPlaying: false,
  volume: 80,
  speed: 1,
};

export const systemStatus: SystemStatus = {
  connected: true,
  recording: false,
  playing: false,
  cpuUsage: 32,
  memoryUsage: 48,
  fps: 59.94,
  networkQuality: 'excellent',
  delayMs: 120,
};
