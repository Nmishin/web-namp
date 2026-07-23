/**
 * Yandex Music API client: token validation, track search, and the
 * download-info + MD5 sign flow that resolves a track id to a streamable URL.
 * See /docs/yandex-api.md for the probed API details.
 *
 * Transport note: requests go through node:https, NOT global fetch/undici.
 * Yandex's edge fingerprints the TLS/HTTP client and serves a 403 HTML block
 * page to undici, while node:https (and curl) pass through. Verified: an
 * invalid token yields 403 HTML via fetch but a normal 401 JSON via node:https.
 */
import { createHash } from 'node:crypto';
import https from 'node:https';
import type { PlaylistSummary, Track } from '@shared';

const API_BASE = 'https://api.music.yandex.net';
const SIGN_SALT = 'XGRlBW9FXlekgbPrRHuSiA';

/** Error carrying the HTTP status the API layer should respond with. */
export class UpstreamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `OAuth ${token}`,
    // A browser-ish UA plus the mobile client marker; node:https already clears
    // the edge, these just keep us looking like a legitimate client.
    'User-Agent': 'Yandex-Music-API',
    'X-Yandex-Music-Client': 'YandexMusicAndroid/24023231',
    'Accept-Language': 'ru,en;q=0.9',
  };
}

interface HttpResult {
  status: number;
  body: string;
}

/** Minimal node:https request that buffers a (text) response. */
function httpsRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  const { method = 'GET', headers = {}, body } = opts;
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('request timed out')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

interface AccountStatusResponse {
  result?: {
    account?: {
      uid?: number;
      login?: string;
      displayName?: string;
    };
  };
}

/** A validated account: login for display, uid for the per-user endpoints. */
export interface ValidatedAccount {
  login: string;
  uid: number;
}

/**
 * Validates a token against GET /account/status.
 * Returns the account login + uid for a valid token, null for an invalid one.
 * Throws UpstreamError on network/unexpected upstream failures.
 */
export async function validateToken(token: string): Promise<ValidatedAccount | null> {
  let res: HttpResult;
  try {
    res = await httpsRequest(`${API_BASE}/account/status`, { headers: authHeaders(token) });
  } catch (err) {
    throw new UpstreamError(502, `Could not reach Yandex Music: ${errorMessage(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    console.warn(`[auth] /account/status → ${res.status}: ${res.body.slice(0, 160).replace(/\s+/g, ' ')}`);
    return null;
  }
  if (res.status < 200 || res.status >= 300) {
    throw new UpstreamError(502, `Yandex /account/status responded ${res.status}`);
  }
  const data = JSON.parse(res.body) as AccountStatusResponse;
  const account = data.result?.account;
  // An anonymous/invalid session yields an empty account object.
  if (!account || (account.uid === undefined && !account.login)) {
    console.warn('[auth] /account/status → 200 but account is anonymous (token not accepted)');
    return null;
  }
  const login = account.login ?? account.displayName ?? String(account.uid);
  const uid = account.uid ?? 0;
  console.log(`[auth] token OK — login "${login}" (uid ${uid})`);
  return { login, uid };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface YandexTrack {
  id: number | string;
  title?: string;
  durationMs?: number;
  available?: boolean;
  artists?: Array<{ name?: string }>;
  albums?: Array<{ id?: number | string; title?: string }>;
}

interface SearchApiResponse {
  result?: {
    tracks?: {
      results?: YandexTrack[];
    };
  };
}

function toTrack(t: YandexTrack): Track {
  return {
    id: String(t.id),
    title: t.title ?? 'Unknown title',
    artist: (t.artists ?? [])
      .map((a) => a.name)
      .filter((name): name is string => Boolean(name))
      .join(', '),
    album: t.albums?.[0]?.title ?? null,
    durationMs: t.durationMs ?? 0,
    bitrateKbps: null, // not known at search time
  };
}

export async function searchTracks(token: string, q: string): Promise<Track[]> {
  const url = new URL(`${API_BASE}/search`);
  url.searchParams.set('text', q);
  url.searchParams.set('type', 'track');
  url.searchParams.set('page', '0');
  let res: HttpResult;
  try {
    res = await httpsRequest(url.toString(), { headers: authHeaders(token) });
  } catch (err) {
    throw new UpstreamError(502, `Could not reach Yandex Music: ${errorMessage(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamError(401, 'Yandex rejected the stored token');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new UpstreamError(502, `Yandex /search responded ${res.status}`);
  }
  const data = JSON.parse(res.body) as SearchApiResponse;
  const results = data.result?.tracks?.results ?? [];
  return results.filter((t) => t.available !== false).map(toTrack);
}

// ---------------------------------------------------------------------------
// Streaming: download-info + MD5 sign flow
// ---------------------------------------------------------------------------

interface DownloadVariant {
  codec?: string;
  bitrateInKbps?: number;
  preview?: boolean;
  downloadInfoUrl?: string;
}

interface DownloadInfoResponse {
  result?: DownloadVariant[];
}

/** Extracts <tag>value</tag> from the trivial download-info XML. */
function xmlTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? (m[1] as string) : null;
}

/**
 * Resolves a Yandex track id to a direct, signed audio URL:
 * 1. GET /tracks/:id/download-info, pick the best non-preview mp3 variant.
 * 2. GET its downloadInfoUrl → XML with host/path/ts/s.
 * 3. sign = md5(SALT + path.slice(1) + s); url = https://host/get-mp3/sign/ts+path
 */
export async function resolveStreamUrl(token: string, id: string): Promise<string> {
  let res: HttpResult;
  try {
    res = await httpsRequest(`${API_BASE}/tracks/${encodeURIComponent(id)}/download-info`, {
      headers: authHeaders(token),
    });
  } catch (err) {
    throw new UpstreamError(502, `Could not reach Yandex Music: ${errorMessage(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamError(401, 'Yandex rejected the stored token');
  }
  if (res.status === 404) throw new UpstreamError(404, `Unknown track id: ${id}`);
  if (res.status < 200 || res.status >= 300) {
    throw new UpstreamError(502, `Yandex /download-info responded ${res.status}`);
  }

  const data = JSON.parse(res.body) as DownloadInfoResponse;
  const variants = (data.result ?? []).filter(
    (v) => v.codec === 'mp3' && typeof v.downloadInfoUrl === 'string',
  );
  if (variants.length === 0) {
    throw new UpstreamError(502, 'No mp3 stream variant available for this track');
  }
  // Prefer full (non-preview) variants, then highest bitrate.
  variants.sort(
    (a, b) =>
      Number(a.preview === true) - Number(b.preview === true) ||
      (b.bitrateInKbps ?? 0) - (a.bitrateInKbps ?? 0),
  );
  const best = variants[0] as DownloadVariant;

  let infoRes: HttpResult;
  try {
    infoRes = await httpsRequest(best.downloadInfoUrl as string, { headers: authHeaders(token) });
  } catch (err) {
    throw new UpstreamError(502, `Could not fetch download info: ${errorMessage(err)}`);
  }
  if (infoRes.status < 200 || infoRes.status >= 300) {
    throw new UpstreamError(502, `Yandex downloadInfoUrl responded ${infoRes.status}`);
  }
  const xml = infoRes.body;
  const host = xmlTag(xml, 'host');
  const path = xmlTag(xml, 'path');
  const ts = xmlTag(xml, 'ts');
  const s = xmlTag(xml, 's');
  if (!host || !path || !ts || !s) {
    throw new UpstreamError(502, 'Malformed download-info XML from Yandex');
  }
  const sign = createHash('md5').update(SIGN_SALT + path.slice(1) + s).digest('hex');
  return `https://${host}/get-mp3/${sign}/${ts}${path}`;
}

/**
 * Best-effort: the bitrate (kbps) of the variant we'd actually stream for a
 * track. Returns null on any failure — it's only used to light up the LCD.
 */
export async function getBitrate(token: string, id: string): Promise<number | null> {
  let res: HttpResult;
  try {
    res = await httpsRequest(`${API_BASE}/tracks/${encodeURIComponent(id)}/download-info`, {
      headers: authHeaders(token),
    });
  } catch (err) {
    console.warn(`[bitrate] ${id} fetch failed: ${errorMessage(err)}`);
    return null;
  }
  if (res.status < 200 || res.status >= 300) return null;
  try {
    const data = JSON.parse(res.body) as DownloadInfoResponse;
    const variants = (data.result ?? []).filter((v) => v.codec === 'mp3');
    if (variants.length === 0) return null;
    variants.sort(
      (a, b) =>
        Number(a.preview === true) - Number(b.preview === true) ||
        (b.bitrateInKbps ?? 0) - (a.bitrateInKbps ?? 0),
    );
    return variants[0]?.bitrateInKbps ?? null;
  } catch (err) {
    console.warn(`[bitrate] ${id} parse failed: ${errorMessage(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// "Моя волна" / My Wave — the rotor personalized AI radio
// ---------------------------------------------------------------------------

const WAVE_STATION = 'user:onyourwave';

interface RotorSequenceItem {
  track?: YandexTrack;
}
interface RotorTracksResponse {
  result?: {
    batchId?: string;
    sequence?: RotorSequenceItem[];
  };
}

export interface WaveBatch {
  tracks: Track[];
  sessionId: string | null;
}

/** Target queue depth when starting/extending the wave, and a request cap. */
const WAVE_TARGET = 24;
const WAVE_MAX_REQUESTS = 8;

async function fetchWaveBatch(token: string, queue?: string): Promise<WaveBatch> {
  const url = new URL(`${API_BASE}/rotor/station/${WAVE_STATION}/tracks`);
  url.searchParams.set('settings2', 'true');
  if (queue) url.searchParams.set('queue', queue);
  let res: HttpResult;
  try {
    res = await httpsRequest(url.toString(), { headers: authHeaders(token) });
  } catch (err) {
    throw new UpstreamError(502, `Could not reach Yandex Music: ${errorMessage(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamError(401, 'Yandex rejected the stored token');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new UpstreamError(502, `Yandex rotor/tracks responded ${res.status}`);
  }
  const data = JSON.parse(res.body) as RotorTracksResponse;
  const tracks = (data.result?.sequence ?? [])
    .map((item) => item.track)
    .filter((t): t is YandexTrack => Boolean(t) && t?.available !== false)
    .map(toTrack);
  return { tracks, sessionId: data.result?.batchId ?? null };
}

/**
 * Builds a deep wave queue (≥ WAVE_TARGET tracks) by pulling several rotor
 * batches back to back, each advancing from the previous batch's last track.
 */
export async function fetchWave(token: string, afterTrackId?: string): Promise<WaveBatch> {
  const collected: Track[] = [];
  const seen = new Set<string>();
  let sessionId: string | null = null;
  let queue = afterTrackId;
  for (let req = 0; req < WAVE_MAX_REQUESTS && collected.length < WAVE_TARGET; req++) {
    const batch = await fetchWaveBatch(token, queue);
    if (batch.sessionId) sessionId = batch.sessionId;
    if (batch.tracks.length === 0) break;
    let added = 0;
    for (const t of batch.tracks) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        collected.push(t);
        added++;
      }
    }
    const last = batch.tracks[batch.tracks.length - 1];
    if (last) queue = last.id; // advance the wave for the next batch
    if (added === 0) break; // rotor returned only repeats — stop
  }
  return { tracks: collected, sessionId };
}

export type WaveFeedbackEvent = 'trackStarted' | 'trackFinished' | 'skip';

/**
 * Reports a playback event to the rotor so the wave adapts. Best-effort:
 * resolves even if Yandex rejects it — the caller must not fail user playback
 * over a missed feedback ping.
 */
export async function sendWaveFeedback(
  token: string,
  event: WaveFeedbackEvent,
  trackId: string,
  batchId: string | null,
  totalPlayedSeconds?: number,
): Promise<void> {
  const url = new URL(`${API_BASE}/rotor/station/${WAVE_STATION}/feedback`);
  if (batchId) url.searchParams.set('batch-id', batchId);
  const payload: Record<string, unknown> = {
    type: event,
    timestamp: new Date().toISOString(),
    trackId,
    from: 'web-namp',
  };
  if (totalPlayedSeconds !== undefined) payload['totalPlayedSeconds'] = totalPlayedSeconds;
  const body = JSON.stringify(payload);
  try {
    const res = await httpsRequest(url.toString(), {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body,
    });
    if (res.status < 200 || res.status >= 300) {
      console.warn(`[wave] feedback "${event}" for ${trackId} → HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[wave] feedback "${event}" for ${trackId} failed: ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Playlists (the user's own lists + the "Liked tracks" pseudo-playlist)
// ---------------------------------------------------------------------------

/** Shared GET → JSON with the standard auth/status handling of this module. */
async function apiGet<T>(token: string, url: string, label: string): Promise<T> {
  let res: HttpResult;
  try {
    res = await httpsRequest(url, { headers: authHeaders(token) });
  } catch (err) {
    throw new UpstreamError(502, `Could not reach Yandex Music: ${errorMessage(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamError(401, 'Yandex rejected the stored token');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new UpstreamError(502, `Yandex ${label} responded ${res.status}`);
  }
  return JSON.parse(res.body) as T;
}

interface PlaylistListItem {
  kind?: number | string;
  title?: string;
  trackCount?: number;
}
interface PlaylistListResponse {
  result?: PlaylistListItem[];
}

interface LikesTracksResponse {
  result?: {
    library?: {
      tracks?: Array<{ id?: number | string; albumId?: number | string }>;
    };
  };
}

interface TracksByIdResponse {
  result?: YandexTrack[];
}

interface PlaylistWithTracksResponse {
  result?: {
    title?: string;
    trackCount?: number;
    revision?: number;
    tracks?: Array<{ track?: YandexTrack }>;
  };
}

/** Max track ids per /tracks batch when resolving Liked-track metadata. */
const TRACKS_BATCH = 100;

/**
 * The connected user's playlists, with a synthetic "Liked tracks" entry
 * prepended (id "liked"). Order: Liked first, then the user's own lists.
 */
export async function fetchPlaylists(token: string, uid: number): Promise<PlaylistSummary[]> {
  const [list, likes] = await Promise.all([
    apiGet<PlaylistListResponse>(token, `${API_BASE}/users/${uid}/playlists/list`, 'playlists/list'),
    apiGet<LikesTracksResponse>(token, `${API_BASE}/users/${uid}/likes/tracks`, 'likes/tracks'),
  ]);
  const likedCount = likes.result?.library?.tracks?.length ?? 0;
  const playlists: PlaylistSummary[] = (list.result ?? []).map((p) => ({
    id: String(p.kind),
    title: p.title ?? 'Untitled playlist',
    trackCount: p.trackCount ?? 0,
  }));
  playlists.unshift({ id: 'liked', title: 'Liked tracks', trackCount: likedCount });
  return playlists;
}

/**
 * Tracks of one playlist, normalized. `id` is either "liked" (the Liked-tracks
 * pseudo-playlist, whose ids are resolved to full metadata in batches) or a
 * numeric playlist "kind".
 */
export async function fetchPlaylistTracks(token: string, uid: number, id: string): Promise<Track[]> {
  if (id === 'liked') {
    const likes = await apiGet<LikesTracksResponse>(
      token,
      `${API_BASE}/users/${uid}/likes/tracks`,
      'likes/tracks',
    );
    const ids = (likes.result?.library?.tracks ?? [])
      .map((t) => (t.id === undefined ? null : String(t.id)))
      .filter((x): x is string => x !== null);
    const tracks: Track[] = [];
    for (let i = 0; i < ids.length; i += TRACKS_BATCH) {
      // Ids are numeric strings, so literal commas need no encoding — this
      // matches the probed `?track-ids=<id1,id2,...>` format exactly.
      const batch = ids.slice(i, i + TRACKS_BATCH).join(',');
      const data = await apiGet<TracksByIdResponse>(
        token,
        `${API_BASE}/tracks?track-ids=${batch}`,
        'tracks',
      );
      for (const t of data.result ?? []) {
        if (t.available !== false) tracks.push(toTrack(t));
      }
    }
    return tracks;
  }

  const data = await apiGet<PlaylistWithTracksResponse>(
    token,
    `${API_BASE}/users/${uid}/playlists/${encodeURIComponent(id)}`,
    'playlists/:id',
  );
  return (data.result?.tracks ?? [])
    .map((item) => item.track)
    .filter((t): t is YandexTrack => Boolean(t) && t?.available !== false)
    .map(toTrack);
}

// ---------------------------------------------------------------------------
// Writes: like / unlike, and playlist creation
// ---------------------------------------------------------------------------

/** Shared form-encoded POST → JSON with this module's auth/status handling. */
async function apiPost<T>(
  token: string,
  url: string,
  form: Record<string, string>,
  label: string,
): Promise<T> {
  let res: HttpResult;
  try {
    res = await httpsRequest(url, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    throw new UpstreamError(502, `Could not reach Yandex Music: ${errorMessage(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamError(401, 'Yandex rejected the stored token');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new UpstreamError(502, `Yandex ${label} responded ${res.status}`);
  }
  return JSON.parse(res.body) as T;
}

/** Like (add-multiple) or unlike (remove) a single track. */
export async function likeTrack(
  token: string,
  uid: number,
  trackId: string,
  liked: boolean,
): Promise<void> {
  const action = liked ? 'add-multiple' : 'remove';
  await apiPost(token, `${API_BASE}/users/${uid}/likes/tracks/${action}`, { 'track-ids': trackId }, `likes/${action}`);
}

/** Ids of the user's liked tracks (so the UI can show the current like state). */
export async function fetchLikedIds(token: string, uid: number): Promise<string[]> {
  const likes = await apiGet<LikesTracksResponse>(
    token,
    `${API_BASE}/users/${uid}/likes/tracks`,
    'likes/tracks',
  );
  return (likes.result?.library?.tracks ?? [])
    .map((t) => (t.id === undefined ? null : String(t.id)))
    .filter((x): x is string => x !== null);
}

interface CreatePlaylistApiResponse {
  result?: { kind?: number | string; title?: string; trackCount?: number; revision?: number };
}

/** Resolves each track id to its primary albumId (change-relative needs both). */
async function resolveAlbumIds(token: string, trackIds: string[]): Promise<Map<string, string>> {
  const idToAlbum = new Map<string, string>();
  for (let i = 0; i < trackIds.length; i += TRACKS_BATCH) {
    const batch = trackIds.slice(i, i + TRACKS_BATCH).join(',');
    const data = await apiGet<TracksByIdResponse>(token, `${API_BASE}/tracks?track-ids=${batch}`, 'tracks');
    for (const t of data.result ?? []) {
      const albumId = t.albums?.[0]?.id;
      if (t.id !== undefined && albumId !== undefined) idToAlbum.set(String(t.id), String(albumId));
    }
  }
  return idToAlbum;
}

/**
 * Inserts tracks into a playlist at position `at` via change-relative and
 * returns the resulting track count. No-op (returns `at`) if nothing resolves.
 */
async function insertTracks(
  token: string,
  uid: number,
  kind: string | number,
  trackIds: string[],
  revision: number,
  at: number,
): Promise<number> {
  const idToAlbum = await resolveAlbumIds(token, trackIds);
  const toInsert = trackIds
    .filter((id) => idToAlbum.has(id))
    .map((id) => ({ id, albumId: idToAlbum.get(id) as string }));
  if (toInsert.length === 0) return at;
  const diff = JSON.stringify([{ op: 'insert', at, tracks: toInsert }]);
  const changed = await apiPost<CreatePlaylistApiResponse>(
    token,
    `${API_BASE}/users/${uid}/playlists/${kind}/change-relative`,
    { diff, revision: String(revision) },
    'playlists/change-relative',
  );
  return changed.result?.trackCount ?? at + toInsert.length;
}

/**
 * Creates a private playlist and, when trackIds are given, inserts them.
 */
export async function createPlaylist(
  token: string,
  uid: number,
  title: string,
  trackIds?: string[],
): Promise<PlaylistSummary> {
  const created = await apiPost<CreatePlaylistApiResponse>(
    token,
    `${API_BASE}/users/${uid}/playlists/create`,
    { title, visibility: 'private' },
    'playlists/create',
  );
  const kind = created.result?.kind;
  if (kind === undefined) throw new UpstreamError(502, 'Yandex did not return the new playlist');
  let trackCount = created.result?.trackCount ?? 0;
  if (trackIds && trackIds.length > 0) {
    trackCount = await insertTracks(token, uid, kind, trackIds, created.result?.revision ?? 1, 0);
  }
  return { id: String(kind), title: created.result?.title ?? title, trackCount };
}

/**
 * Adds tracks to the END of an existing playlist. Fetches the current
 * revision + track count first (change-relative requires the live revision).
 */
export async function addToPlaylist(
  token: string,
  uid: number,
  id: string,
  trackIds: string[],
): Promise<PlaylistSummary> {
  const meta = await apiGet<PlaylistWithTracksResponse>(
    token,
    `${API_BASE}/users/${uid}/playlists/${encodeURIComponent(id)}`,
    'playlists/:id',
  );
  const title = meta.result?.title ?? 'Playlist';
  const revision = meta.result?.revision ?? 1;
  const at = meta.result?.trackCount ?? 0;
  const trackCount = await insertTracks(token, uid, id, trackIds, revision, at);
  return { id, title, trackCount };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
