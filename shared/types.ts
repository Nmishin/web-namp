/**
 * Shared API contract between server and client.
 *
 * IMPORTANT: this package is types-only. Import it with `import type { ... }`
 * so the import is fully erased at build time on both sides.
 */

/** A playable track, normalized (same shape in demo and yandex mode). */
export interface Track {
  /** Opaque string id. Pass verbatim to /api/stream/:id. */
  id: string;
  title: string;
  /** All artist names joined with ", ". */
  artist: string;
  album: string | null;
  durationMs: number;
  /** Nominal bitrate in kbps, null when unknown. */
  bitrateKbps: number | null;
}

export type ServerMode = 'demo' | 'yandex' | 'openvk';

/** GET /api/status → 200 */
export interface StatusResponse {
  mode: ServerMode;
  /** Present only in yandex mode. */
  account: { login: string } | null;
}

/** POST /api/token  body: TokenRequest → 200 TokenResponse | 401 ApiError */
export interface TokenRequest {
  token: string;
}
export interface TokenResponse {
  ok: true;
  account: { login: string };
}

/** GET /api/search?q=<text> → 200. Empty/missing q: demo mode returns all
 *  demo tracks (used to pre-fill the playlist), yandex mode returns []. */
export interface SearchResponse {
  tracks: Track[];
}

/** GET /api/wave?after=<trackId> → 200. "Моя волна" / My Wave — Yandex's
 *  personalized AI radio. Returns the next batch of AI-suggested tracks.
 *  - yandex mode: proxies the rotor station `user:onyourwave`. Pass `after` with
 *    the id of the last track the user reached so the model advances the wave.
 *  - demo mode: returns a simulated wave drawn from the demo catalog so the
 *    feature is usable without credentials.
 *  `sessionId` is echoed back so the client/server can attach rotor feedback. */
export interface WaveResponse {
  tracks: Track[];
  sessionId: string | null;
}

/** POST /api/wave/feedback body: WaveFeedbackRequest → 204 (best-effort).
 *  Reports playback events so the AI wave adapts. No-op in demo mode. */
export interface WaveFeedbackRequest {
  sessionId: string | null;
  trackId: string;
  event: 'trackStarted' | 'trackFinished' | 'skip';
  /** Seconds into the track when the event fired (for finished/skip). */
  totalPlayedSeconds?: number;
}

/** GET /api/playlists → the connected user's playlists.
 *  - yandex mode: the user's own playlists plus a "Liked tracks" pseudo-playlist.
 *  - demo mode: a couple of playlists built from the demo catalog. */
export interface PlaylistSummary {
  /** Opaque id — pass verbatim to /api/playlists/:id/tracks. (Yandex: the
   *  playlist "kind" as a string, or "liked" for the Liked-tracks playlist.) */
  id: string;
  title: string;
  trackCount: number;
}
export interface PlaylistsResponse {
  playlists: PlaylistSummary[];
}

/** GET /api/playlists/:id/tracks → the tracks of one playlist (normalized). */
export interface PlaylistTracksResponse {
  tracks: Track[];
}

/** POST /api/like body: LikeRequest → 200 LikeResponse.
 *  Likes (liked=true) or unlikes the track. No-op in demo mode. */
export interface LikeRequest {
  trackId: string;
  liked: boolean;
}
export interface LikeResponse {
  liked: boolean;
}

/** GET /api/liked-ids → the ids of the user's liked tracks (empty in demo). */
export interface LikedIdsResponse {
  ids: string[];
}

/** POST /api/playlists/create body: CreatePlaylistRequest → 200 PlaylistSummary.
 *  Creates a private playlist; when trackIds are given they're added to it. */
export interface CreatePlaylistRequest {
  title: string;
  trackIds?: string[];
}

/** GET /api/bitrate/:id → the playable stream's bitrate in kbps (null if
 *  unknown). Search results don't carry a bitrate — it's only known once the
 *  stream variant is resolved — so the client fetches this on track change. */
export interface BitrateResponse {
  kbps: number | null;
}

/** Every non-2xx JSON response has this shape. */
export interface ApiError {
  error: string;
}
