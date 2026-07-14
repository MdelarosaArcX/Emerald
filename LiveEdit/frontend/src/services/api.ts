import type { Timeline } from '@/types/clip';
import type { ApiResponse, CaptureInfo, PlaybackInfo, Project, SystemStatus } from '@/types/project';

const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const body = (await res.json()) as ApiResponse<T>;

  if (!res.ok || !body.success) {
    throw new Error(body.error ?? `Request to ${path} failed with status ${res.status}`);
  }

  return body.data as T;
}

/**
 * Thin REST client wrapping the Emerald Live Edit backend API.
 * Every method maps 1:1 to a documented backend endpoint.
 */
export const api = {
  getProject: () => request<Project>('/project'),
  getTimeline: () => request<Timeline>('/timeline'),
  getStatus: () => request<SystemStatus>('/status'),

  play: (clipId?: string) =>
    request<PlaybackInfo>('/play', { method: 'POST', body: JSON.stringify({ clipId }) }),
  pause: () => request<PlaybackInfo>('/pause', { method: 'POST' }),
  stop: () => request<PlaybackInfo>('/stop', { method: 'POST' }),

  importMedia: (payload: { name: string; path: string; type: 'video' | 'audio' | 'image' }) =>
    request('/import', { method: 'POST', body: JSON.stringify(payload) }),

  toggleCapture: (action: 'start' | 'stop') =>
    request<CaptureInfo>('/capture', { method: 'POST', body: JSON.stringify({ action }) }),

  requestRender: (payload: { format?: string; outputPath?: string }) =>
    request('/render', { method: 'POST', body: JSON.stringify(payload) }),
};
