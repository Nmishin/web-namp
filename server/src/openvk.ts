/**
 * OpenVK (VK API-compatible) music client: token validation, track search,
 * playlist management, and audio streaming.
 *
 * OpenVK exposes a VK API-compatible REST interface at
 * `{instanceUrl}/method/{methodName}`. Auth: `access_token` query param or
 * `Authorization: Bearer` header. Response envelope:
 *   success: { "response": ... }
 *   error:   { "error": { "error_code": N, "error_msg": "..." } }
 *
 * Transport: node:https GET requests with JSON parsing. The audio `url` field
 * from `audio.getById` is a direct MP3 URL (requires `exposeOriginalURLs: true`
 * in the OpenVK instance config).
 */
import https from 'node:https';
import type { PlaylistSummary, Track } from '@shared';

/** Error carrying the HTTP status the API layer should respond with. */
export class UpstreamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Low-level HTTP + VK API helpers
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: string;
}

function httpsGet(url: string, cookie?: string, origin?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Accept: 'application/json',
      'Accept-Language': 'ru,en;q=0.9',
    };
    if (cookie) headers['Cookie'] = cookie;
    if (origin) {
      headers['Origin'] = origin;
      headers['Referer'] = origin + '/';
    }
    const req = https.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('request timed out')));
  });
}

interface VkError {
  error_code?: number;
  error_msg?: string;
}

interface VkResponse<T> {
  response?: T;
  error?: VkError;
}

/**
 * Calls a VK API method and returns the parsed `response` field.
 * Throws UpstreamError on network/API errors.
 */
async function vkCall<T>(
  instanceUrl: string,
  method: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${instanceUrl}/method/${method}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== '') url.searchParams.set(k, v);
  }
  url.searchParams.set('v', '5.131');

  let res: HttpResult;
  try {
    res = await httpsGet(url.toString());
  } catch (err) {
    throw new UpstreamError(502, `Could not reach OpenVK: ${errorMessage(err)}`);
  }

  if (res.status < 200 || res.status >= 300) {
    throw new UpstreamError(502, `OpenVK ${method} responded HTTP ${res.status}`);
  }

  const data = JSON.parse(res.body) as VkResponse<T>;
  if (data.error) {
    throw new UpstreamError(
      502,
      `VK API error #${data.error.error_code ?? '?'}: ${data.error.error_msg ?? 'unknown'}`,
    );
  }
  if (data.response === undefined) {
    throw new UpstreamError(502, `VK API ${method}: missing "response" field`);
  }
  return data.response;
}

// ---------------------------------------------------------------------------
// Instance URL
// ---------------------------------------------------------------------------

/**
 * Normalises the instance URL: adds https:// if missing, strips trailing slash.
 */
export function normaliseInstanceUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/+$/, '');
}

/**
 * Direct login: exchanges OpenVK credentials for an access token via the
 * VK API `/token` endpoint (grant_type=password).
 *
 * Returns {token, login, uid} on success, null on bad credentials.
 * Throws UpstreamError on network/instance failures.
 */
export async function directLogin(
  username: string,
  password: string,
  instanceUrl: string,
): Promise<{ token: string; login: string; uid: number } | null> {
  // Try GET — avoids CSRF issues that block POST
  const params = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
    client_name: 'web-namp',
  });
  const url = `${instanceUrl}/token?${params.toString()}`;

  let res: HttpResult;
  try {
    res = await httpsGet(url);
  } catch (err) {
    throw new UpstreamError(502, `Could not reach OpenVK: ${errorMessage(err)}`);
  }

  if (res.status < 200 || res.status >= 300) {
    console.error(
      `[openvk] direct login failed — HTTP ${res.status}, body: ${res.body.slice(0, 200)}`,
    );
    return null;
  }

  try {
    const data = JSON.parse(res.body) as {
      access_token?: string;
      user_id?: number;
      error?: string;
    };
    if (data.access_token) {
      const token = data.access_token;
      // Validate the freshly-obtained token via users.get
      let login: string;
      let uid: number;
      try {
        const users = await vkCall<{ id: number; first_name?: string; last_name?: string }[]>(
          instanceUrl, 'users.get', { access_token: token },
        );
        if (!users[0]?.id) return null;
        uid = users[0].id;
        login = [users[0].first_name, users[0].last_name].filter(Boolean).join(' ') || `id${uid}`;
      } catch {
        return null;
      }
      return { token, login, uid };
    }
    if (data.error) {
      console.error(`[openvk] direct login VK error: ${data.error}`);
    }
  } catch {
    console.error(`[openvk] direct login — invalid JSON: ${res.body.slice(0, 200)}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

async function callApi<T>(
  instanceUrl: string,
  method: string,
  extra: Record<string, string>,
  token: string,
): Promise<T> {
  return vkCall<T>(instanceUrl, method, { access_token: token, ...extra });
}

// ---------------------------------------------------------------------------
// Track object mapping
// ---------------------------------------------------------------------------

interface VkAudio {
  id: number;
  owner_id: number;
  artist: string;
  title: string;
  duration: number;
  url?: string | false;
  genre_id?: number;
  album?: VkAlbum | null;
}

interface VkAlbum {
  id: number;
  owner_id: number;
  title: string;
}

/** VK-style track id: "ownerId_virtualId". */
function vkTrackId(audio: VkAudio): string {
  return `${audio.owner_id}_${audio.id}`;
}

/** Parses "ownerId_virtualId" back to {owner_id, id}. */
function parseVkTrackId(id: string): { ownerId: number; audioId: number } | null {
  const parts = id.split('_');
  if (parts.length !== 2) return null;
  const ownerId = Number(parts[0]);
  const audioId = Number(parts[1]);
  if (!Number.isFinite(ownerId) || !Number.isFinite(audioId)) return null;
  return { ownerId, audioId };
}

function toTrack(audio: VkAudio): Track {
  return {
    id: vkTrackId(audio),
    title: audio.title || 'Unknown title',
    artist: audio.artist || 'Unknown artist',
    album: audio.album?.title ?? null,
    durationMs: (audio.duration ?? 0) * 1000,
    bitrateKbps: null, // VK API doesn't expose bitrate
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface VkAudioSearchResponse {
  count: number;
  items: VkAudio[];
}

export async function searchTracks(
  token: string,
  instanceUrl: string,
  q: string,
): Promise<Track[]> {
  const data = await callApi<VkAudioSearchResponse>(instanceUrl, 'audio.search', {
    q,
    count: '50',
    sort: '2',
  }, token);
  return (data.items ?? []).map(toTrack);
}

// ---------------------------------------------------------------------------
// Streaming: get the direct MP3 URL
// ---------------------------------------------------------------------------

export async function resolveStreamUrl(
  token: string,
  instanceUrl: string,
  trackId: string,
): Promise<string> {
  const parsed = parseVkTrackId(trackId);
  if (!parsed) throw new UpstreamError(400, `Invalid track id: ${trackId}`);

  interface GetByIdResponse { count: number; items: VkAudio[] }
  const data = await callApi<GetByIdResponse>(instanceUrl, 'audio.getById', {
    audios: trackId,
  }, token);

  const audio = data.items?.[0];
  if (!audio || !audio.url) {
    throw new UpstreamError(404, `Track not available: ${trackId}`);
  }

  return audio.url;
}

// ---------------------------------------------------------------------------
// Playlists (VK "albums")
// ---------------------------------------------------------------------------

interface VkPlaylistSummary {
  id: number;
  owner_id: number;
  title: string;
  size?: number;
}

interface VkPlaylistsResponse {
  count: number;
  items: VkPlaylistSummary[];
}

function playlistPrettyId(pl: VkPlaylistSummary): string {
  return `${pl.owner_id}_${pl.id}`;
}

export async function fetchPlaylists(
  token: string,
  uid: number,
  instanceUrl: string,
): Promise<PlaylistSummary[]> {
  const data = await callApi<VkPlaylistsResponse>(instanceUrl, 'audio.getAlbums', {
    owner_id: String(uid),
    count: '100',
  }, token);

  const playlists: PlaylistSummary[] = (data.items ?? []).map((pl) => ({
    id: playlistPrettyId(pl),
    title: pl.title ?? 'Untitled',
    trackCount: pl.size ?? 0,
  }));

  // Prepend "My tracks" — all tracks in the user's library
  try {
    const cnt = await callApi<number>(instanceUrl, 'audio.getCount', {
      owner_id: String(uid),
    }, token);
    playlists.unshift({ id: `my_${uid}`, title: 'My tracks', trackCount: cnt });
  } catch {
    playlists.unshift({ id: `my_${uid}`, title: 'My tracks', trackCount: 0 });
  }

  return playlists;
}

interface VkPlaylistWithTracks {
  count: number;
  items: VkAudio[];
}

export async function fetchPlaylistTracks(
  token: string,
  uid: number,
  playlistId: string,
  instanceUrl: string,
): Promise<Track[]> {
  // "My tracks" pseudo-playlist — load all library tracks
  if (playlistId.startsWith('my_')) {
    const data = await callApi<VkPlaylistWithTracks>(instanceUrl, 'audio.get', {
      owner_id: String(uid),
      count: '6000',
    }, token);
    return (data.items ?? []).map(toTrack);
  }

  const parsed = parseVkTrackId(playlistId);
  if (!parsed) throw new UpstreamError(400, `Invalid playlist id: ${playlistId}`);

  const data = await callApi<VkPlaylistWithTracks>(instanceUrl, 'audio.get', {
    owner_id: String(parsed.ownerId),
    album_id: String(parsed.audioId),
    count: '6000',
  }, token);

  return (data.items ?? []).map(toTrack);
}

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

export async function fetchLikedIds(
  token: string,
  _uid: number,
  instanceUrl: string,
): Promise<string[]> {
  const data = await callApi<VkPlaylistWithTracks>(instanceUrl, 'audio.get', {
    owner_id: String(_uid),
    count: '6000',
  }, token);
  return (data.items ?? []).map(vkTrackId);
}

export async function likeTrack(
  token: string,
  _uid: number,
  trackId: string,
  liked: boolean,
  instanceUrl: string,
): Promise<void> {
  const parsed = parseVkTrackId(trackId);
  if (!parsed) throw new UpstreamError(400, `Invalid track id: ${trackId}`);

  if (liked) {
    await callApi<number>(instanceUrl, 'audio.add', {
      audio_id: String(parsed.audioId),
      owner_id: String(parsed.ownerId),
    }, token);
  } else {
    await callApi<number>(instanceUrl, 'audio.delete', {
      audio_id: String(parsed.audioId),
      owner_id: String(parsed.ownerId),
    }, token);
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
