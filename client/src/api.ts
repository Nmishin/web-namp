/**
 * Typed fetch wrappers for the web-namp server contract.
 *
 * This module is the ONLY place in the client that knows the /api/* URLs.
 * All requests are same-origin relative paths; in dev the vite proxy forwards
 * them to http://localhost:8058 (see vite.config.ts).
 *
 * Static build (`import.meta.env.VITE_STATIC` set, i.e. `npm run build:pages`
 * for GitHub Pages): there is no server, so every function below routes to the
 * in-browser demo backend instead of fetching /api/*. The non-static path is
 * left exactly as-is so dev/prod against the real server are unaffected. This
 * keeps api.ts the single source of truth for the /api contract.
 */
import type {
  ApiError,
  BitrateResponse,
  CreatePlaylistRequest,
  LikedIdsResponse,
  LikeRequest,
  LikeResponse,
  PlaylistsResponse,
  PlaylistSummary,
  PlaylistTracksResponse,
  SearchResponse,
  StatusResponse,
  TokenRequest,
  TokenResponse,
  WaveFeedbackRequest,
  WaveResponse,
} from '@shared';
import * as demo from './demo-backend';

/** Best-effort human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // fetch() only rejects on network-level failures (server down, DNS, ...).
    throw new Error(`network error: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as Partial<ApiError>;
      if (typeof body.error === 'string' && body.error.length > 0) {
        message = body.error;
      }
    } catch (parseErr) {
      // Error body was not JSON — keep the HTTP status message, but log why.
      console.warn(`[api] non-JSON error body from ${url}:`, parseErr);
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** GET /api/status → { mode, account } */
export function getStatus(): Promise<StatusResponse> {
  if (import.meta.env.VITE_STATIC) return demo.getStatus();
  return requestJson<StatusResponse>('/api/status');
}

/** POST /api/mode { mode: 'demo'|'yandex'|'openvk' } → StatusResponse. */
export function setMode(mode: string): Promise<StatusResponse> {
  if (import.meta.env.VITE_STATIC) return demo.getStatus();
  return requestJson<StatusResponse>('/api/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
}

/** POST /api/token { token } → { ok: true, account } (throws with server `error` on 401). */
export function submitToken(token: string): Promise<TokenResponse> {
  if (import.meta.env.VITE_STATIC) return demo.submitToken(token);
  const body: TokenRequest = { token };
  return requestJson<TokenResponse>('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** GET /api/search?q=<text> → { tracks }. Empty q pre-fills the demo playlist. */
export function searchTracks(q: string): Promise<SearchResponse> {
  if (import.meta.env.VITE_STATIC) return demo.searchTracks(q);
  return requestJson<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`);
}

/**
 * URL used directly as <audio>.src. Server build: GET /api/stream/:id
 * (Range-capable). Static build: a same-origin blob: URL for a WAV synthesized
 * on demand in the browser (also Range-capable → seeking + analyser work).
 */
export function streamUrl(id: string): string {
  if (import.meta.env.VITE_STATIC) return demo.streamUrl(id);
  return `/api/stream/${encodeURIComponent(id)}`;
}

/** GET /api/bitrate/:id → { kbps } for the resolved stream (null if unknown).
 *  Static build: demo tracks already carry their bitrate, so this is a no-op. */
export function getBitrate(id: string): Promise<BitrateResponse> {
  if (import.meta.env.VITE_STATIC) return Promise.resolve({ kbps: null });
  return requestJson<BitrateResponse>(`/api/bitrate/${encodeURIComponent(id)}`);
}

/** GET /api/playlists → { playlists }. The user's playlists (demo: from catalog). */
export function getPlaylists(): Promise<PlaylistsResponse> {
  if (import.meta.env.VITE_STATIC) return demo.getPlaylists();
  return requestJson<PlaylistsResponse>('/api/playlists');
}

/** GET /api/playlists/:id/tracks → { tracks } for one playlist. */
export function getPlaylistTracks(id: string): Promise<PlaylistTracksResponse> {
  if (import.meta.env.VITE_STATIC) return demo.getPlaylistTracks(id);
  return requestJson<PlaylistTracksResponse>(`/api/playlists/${encodeURIComponent(id)}/tracks`);
}

/** GET /api/liked-ids → { ids } of the user's liked tracks (empty in demo). */
export function getLikedIds(): Promise<LikedIdsResponse> {
  if (import.meta.env.VITE_STATIC) return demo.getLikedIds();
  return requestJson<LikedIdsResponse>('/api/liked-ids');
}

/** POST /api/like { trackId, liked } → { liked }. Likes/unlikes one track. */
export function setLike(trackId: string, liked: boolean): Promise<LikeResponse> {
  if (import.meta.env.VITE_STATIC) return demo.setLike(trackId, liked);
  const body: LikeRequest = { trackId, liked };
  return requestJson<LikeResponse>('/api/like', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** POST /api/playlists/create { title, trackIds? } → the new PlaylistSummary. */
export function createPlaylist(title: string, trackIds?: string[]): Promise<PlaylistSummary> {
  if (import.meta.env.VITE_STATIC) return demo.createPlaylist(title, trackIds);
  const body: CreatePlaylistRequest = { title, trackIds };
  return requestJson<PlaylistSummary>('/api/playlists/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** POST /api/playlists/:id/add { trackIds } → the updated PlaylistSummary. */
export function addToPlaylist(id: string, trackIds: string[]): Promise<PlaylistSummary> {
  if (import.meta.env.VITE_STATIC) return demo.addToPlaylist(id, trackIds);
  return requestJson<PlaylistSummary>(`/api/playlists/${encodeURIComponent(id)}/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackIds }),
  });
}

/** GET /api/wave?after=<id> → next batch of AI-suggested "Моя волна" tracks. */
export function getWave(after?: string): Promise<WaveResponse> {
  if (import.meta.env.VITE_STATIC) return demo.getWave(after);
  const qs = after ? `?after=${encodeURIComponent(after)}` : '';
  return requestJson<WaveResponse>(`/api/wave${qs}`);
}

/**
 * POST /api/wave/feedback — best-effort rotor feedback (204, no body).
 * Never throws: a missed feedback ping must not disrupt playback.
 */
export async function sendWaveFeedback(body: WaveFeedbackRequest): Promise<void> {
  if (import.meta.env.VITE_STATIC) return; // demo: no rotor to report to — no-op
  try {
    await fetch('/api/wave/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn('[api] wave feedback failed:', errorMessage(err));
  }
}
