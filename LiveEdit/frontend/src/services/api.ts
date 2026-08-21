import type { Timeline } from '@/types/clip';
import type { ApiResponse, CaptureInfo, MediaAsset, PlaybackInfo, Project, SystemStatus } from '@/types/project';

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
 * Turns an imported asset's root-relative `path` into an absolute URL against the origin serving
 * this page.
 *
 * The rest of the editor treats "is this an absolute http(s) URL" as "is this a real, usable
 * source" — the Program monitor refuses to load anything else, the timeline skips it when
 * prefetching waveforms, and the proxy endpoint rejects it. That test exists because every other
 * source in the app arrives as an absolute URL from the Emerald backend, so a root-relative import
 * path was silently dropped by all three: an imported clip landed on the timeline and then simply
 * never played.
 *
 * Resolving against `location.origin` rather than a configured backend URL is deliberate — it is
 * whatever host the operator has the app open on, which is by definition reachable from their
 * browser and is where /media-imports is served (directly in production, via the dev proxy
 * otherwise). The backend maps these URLs back to local files itself when it needs to read one
 * (see resolveReadableSource), so it never fetches them over the network.
 */
function absolutizeAssetPath(asset: MediaAsset): MediaAsset {
  const absolute = (url: string | undefined): string | undefined =>
    url && url.startsWith('/') ? new URL(url, window.location.origin).href : url;

  // The thumbnail gets the same treatment as the media itself. It is only ever used as an <img>
  // src or a CSS background, both of which resolve a relative URL fine — but an asset that
  // describes itself in absolute terms stays correct wherever it is handed to, including through
  // the drag payload into a timeline clip.
  return { ...asset, path: absolute(asset.path) ?? asset.path, thumbnail: absolute(asset.thumbnail) };
}

/**
 * Thin REST client wrapping the Emerald Live Edit backend API.
 * Every method maps 1:1 to a documented backend endpoint.
 */
export const api = {
  // Imported assets reach the client through here too (the backend merges them into the project),
  // so they need the same absolute-URL treatment as the dedicated imports endpoint below.
  getProject: async () => {
    const project = await request<Project>('/project');
    return { ...project, mediaAssets: project.mediaAssets.map(absolutizeAssetPath) };
  },
  getTimeline: () => request<Timeline>('/timeline'),
  getStatus: () => request<SystemStatus>('/status'),

  play: (clipId?: string) =>
    request<PlaybackInfo>('/play', { method: 'POST', body: JSON.stringify({ clipId }) }),
  pause: () => request<PlaybackInfo>('/pause', { method: 'POST' }),
  stop: () => request<PlaybackInfo>('/stop', { method: 'POST' }),

  /**
   * Registers an asset by path without uploading or probing it (POST /api/import). Predates
   * importMediaFile below and is a different operation: it records metadata for a file the backend
   * is trusted to already have, so the resulting asset has no duration and no playable URL. Use
   * importMediaFile for anything that has to end up on the timeline.
   */
  importMedia: (payload: { name: string; path: string; type: 'video' | 'audio' | 'image' }) =>
    request('/import', { method: 'POST', body: JSON.stringify(payload) }),

  listImportedMedia: async () => (await request<MediaAsset[]>('/media/imports')).map(absolutizeAssetPath),

  /**
   * Uploads a file into the project's media library and returns the probed asset.
   *
   * XMLHttpRequest rather than fetch, purely for `upload.onprogress`: fetch still has no way to
   * report request-body progress, and these are multi-gigabyte video files — an import with no
   * progress is indistinguishable from one that has hung.
   *
   * The body is the file itself, not a FormData part; see the backend's importMedia for why.
   */
  importMediaFile: (file: File, onProgress?: (fraction: number) => void) =>
    new Promise<MediaAsset>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE_URL}/media/import?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded / event.total);
      };

      xhr.onload = () => {
        let body: ApiResponse<MediaAsset>;
        try {
          body = JSON.parse(xhr.responseText) as ApiResponse<MediaAsset>;
        } catch {
          reject(new Error(`Import failed with status ${xhr.status}`));
          return;
        }

        if (xhr.status >= 200 && xhr.status < 300 && body.success && body.data) resolve(absolutizeAssetPath(body.data));
        else reject(new Error(body.error ?? `Import failed with status ${xhr.status}`));
      };

      xhr.onerror = () => reject(new Error('Import failed: could not reach the Live Edit backend.'));
      xhr.onabort = () => reject(new Error('Import cancelled.'));
      xhr.send(file);
    }),

  toggleCapture: (action: 'start' | 'stop') =>
    request<CaptureInfo>('/capture', { method: 'POST', body: JSON.stringify({ action }) }),

  requestRender: (payload: { format?: string; outputPath?: string }) =>
    request('/render', { method: 'POST', body: JSON.stringify(payload) }),
};
