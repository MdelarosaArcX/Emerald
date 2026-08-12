import { v4 as uuid } from 'uuid';
import { Timeline, Track } from '../types/clip';
import { CaptureInfo, MediaAsset, PlaybackInfo, Project, SystemStatus } from '../types/project';

/**
 * In-memory data store standing in for a persistence layer.
 * Replace with a database / real capture-render pipeline later.
 */

const now = new Date().toISOString();

// Empty by design: these used to ship with placeholder demo clips (a "Sponsor Bug" title clip on
// V2 spanning frames 0-900, full-length "Commentary Mix"/"Stadium Ambience" audio, etc.). Because
// ProgramMonitor.vue's `active` computed walks tracks in stacking order and returns the *first*
// one with a clip under the playhead, those higher (lower-order) placeholder tracks silently
// shadowed whatever a real clip a user actually dropped onto V1 — the timeline looked like it had
// a clip, but the monitor kept previewing the fake placeholder underneath it (whose fake
// `/media/*` path isn't a real URL either, so it never even requested a proxy). Track structure
// stays the same; only the seed clips are gone.
// Two video slots by default (V2 on top, V1 below) rather than the old V1-V4 stack — a leaner
// default lane set. Live-captured segments land on the top video lane (see
// timelineStore.appendCaptureSegment); the operator can still add more lanes on demand (+V / +A).
const videoTracks: Track[] = [
  {
    id: 'v2', name: 'V2', kind: 'video', order: 0, height: 72, locked: false, visible: true, muted: false, solo: false,
    clips: [],
  },
  {
    id: 'v1', name: 'V1', kind: 'video', order: 1, height: 72, locked: false, visible: true, muted: false, solo: false,
    clips: [],
  },
];

const audioTracks: Track[] = [
  {
    id: 'a1', name: 'A1', kind: 'audio', order: 2, height: 56, locked: false, visible: true, muted: false, solo: false,
    clips: [],
  },
  {
    id: 'a2', name: 'A2', kind: 'audio', order: 3, height: 56, locked: false, visible: true, muted: false, solo: false,
    clips: [],
  },
];

export const timeline: Timeline = {
  id: 'timeline-main',
  // 25, matching what Emerald actually captures. This is the timeline the editor loads at startup,
  // and it wins over the store's own default — components snapshot timelineStore.fps when they set
  // up, so a different value here would silently put the ruler, playhead and monitors on a
  // different timebase from the clips.
  fps: 25,
  duration: 0,
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
  fps: 25,
  resolution: '1920x1080',
  timelineId: timeline.id,
  mediaAssets,
};

export const captureInfo: CaptureInfo = {
  localPath: 'C:\\EmeraldCaptures\\match_2026_07_13',
  title: 'Matchday Broadcast - Live Feed',
  description: 'Primary ingest from Cam 1, stadium feed.',
  duration: 0,
  fps: 25,
  resolution: '1920x1080',
  codec: 'H.264',
  bitrate: '50 Mbps',
  isCapturing: false,
};

export const playbackInfo: PlaybackInfo = {
  clipId: null,
  filePath: '/media/cam1-wide-001.mov',
  duration: 260,
  fps: 25,
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
  fps: 25,
  networkQuality: 'excellent',
  delayMs: 120,
};
