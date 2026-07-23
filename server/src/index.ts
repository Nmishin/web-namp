/**
 * web-namp server: demo mode (procedural in-memory WAVs) by default,
 * Yandex Music proxy mode once a valid OAuth token is posted to /api/token.
 * API contract: /shared/types.ts
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
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
import {
  demoPlaylists,
  demoPlaylistTracks,
  getDemoEntry,
  searchDemoTracks,
  simulatedWave,
} from './demo';
import {
  UpstreamError,
  addToPlaylist,
  createPlaylist,
  errorMessage,
  fetchLikedIds,
  getBitrate,
  fetchPlaylists,
  fetchPlaylistTracks,
  fetchWave,
  likeTrack,
  resolveStreamUrl,
  searchTracks,
  sendWaveFeedback,
  validateToken,
} from './yandex';
import {
  UpstreamError as OpenVkUpstreamError,
  directLogin as openvkDirectLogin,
  errorMessage as openvkErrorMessage,
  fetchLikedIds as openvkFetchLikedIds,
  fetchPlaylists as openvkFetchPlaylists,
  fetchPlaylistTracks as openvkFetchPlaylistTracks,
  likeTrack as openvkLikeTrack,
  normaliseInstanceUrl,
  resolveStreamUrl as openvkResolveStreamUrl,
  searchTracks as openvkSearchTracks,
} from './openvk';

const app = express();
app.disable('x-powered-by');

/** In-memory session. null → demo mode; set → yandex mode. */
let session: { token: string; login: string; uid: number } | null = null;

/** In-memory OpenVK session. Null → not connected. */
let sessionOpenVK: {
  token: string;
  login: string;
  uid: number;
  instanceUrl: string;
} | null = null;

/** Cached .env credentials for runtime mode switching. */
let cachedYandexToken: string | null = null;
let cachedOpenVkCreds: {
  username?: string;
  password?: string;
  instanceUrl: string;
} | null = null;

// ---------------------------------------------------------------------------
// CORS for all /api routes (permissive: the vite dev client may call us
// directly from http://localhost:5173, or via its proxy).
// ---------------------------------------------------------------------------
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use('/api', express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/status', (_req: Request, res: Response) => {
  let body: StatusResponse;
  if (sessionOpenVK) {
    body = { mode: 'openvk', account: { login: sessionOpenVK.login } };
  } else if (session) {
    body = { mode: 'yandex', account: { login: session.login } };
  } else {
    body = { mode: 'demo', account: null };
  }
  res.json(body);
});

app.post('/api/mode', async (req: Request, res: Response) => {
  const body = req.body as Partial<{ mode: string }> | undefined;
  const mode = typeof body?.mode === 'string' ? body.mode : '';
  if (mode !== 'demo' && mode !== 'yandex' && mode !== 'openvk') {
    res.status(400).json({ error: 'Invalid mode. Use: demo, yandex, openvk' } satisfies ApiError);
    return;
  }
  if (mode === 'demo') {
    session = null; sessionOpenVK = null;
    res.json({ mode: 'demo', account: null } satisfies StatusResponse);
    return;
  }
  if (mode === 'yandex') {
    if (!cachedYandexToken) { res.status(409).json({ error: 'No Yandex token in .env' } satisfies ApiError); return; }
    try {
      const account = await validateToken(cachedYandexToken);
      if (!account) { res.status(401).json({ error: 'Stored Yandex token invalid' } satisfies ApiError); return; }
      session = { token: cachedYandexToken, login: account.login, uid: account.uid };
      sessionOpenVK = null;
      res.json({ mode: 'yandex', account: { login: account.login } } satisfies StatusResponse);
    } catch (err) { respondError(res, err, 'Yandex mode switch failed'); }
    return;
  }
  if (mode === 'openvk') {
    if (!cachedOpenVkCreds) { res.status(409).json({ error: 'No OpenVK config in .env' } satisfies ApiError); return; }
    const c = cachedOpenVkCreds;
    try {
      const instanceUrl = normaliseInstanceUrl(c.instanceUrl);
      if (!c.username || !c.password) {
        res.status(401).json({ error: 'OPENVK_USERNAME and OPENVK_PASSWORD required' } satisfies ApiError);
        return;
      }
      const result = await openvkDirectLogin(c.username, c.password, instanceUrl);
      if (!result) { res.status(401).json({ error: 'OpenVK auth failed' } satisfies ApiError); return; }
      sessionOpenVK = { token: result.token, login: result.login, uid: result.uid, instanceUrl };
      session = null;
      res.json({ mode: 'openvk', account: { login: result.login } } satisfies StatusResponse);
    } catch (err) { respondError(res, err, 'OpenVK mode switch failed'); }
    return;
  }
});

app.post('/api/token', async (req: Request, res: Response) => {
  try {
    const body = req.body as Partial<TokenRequest> | undefined;
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token) {
      res.status(400).json({ error: 'Missing "token" in request body' } satisfies ApiError);
      return;
    }
    const account = await validateToken(token);
    if (!account) {
      res.status(401).json({ error: 'Invalid Yandex Music token' } satisfies ApiError);
      return;
    }
    session = { token, login: account.login, uid: account.uid };
    sessionOpenVK = null;
    console.log(`[auth] yandex mode enabled for account "${account.login}"`);
    res.json({ ok: true, account: { login: account.login } } satisfies TokenResponse);
  } catch (err) {
    respondError(res, err, 'Token validation failed');
  }
});

app.get('/api/search', async (req: Request, res: Response) => {
  const rawQ = req.query.q;
  const q = typeof rawQ === 'string' ? rawQ : Array.isArray(rawQ) && typeof rawQ[0] === 'string' ? rawQ[0] : '';
  if (sessionOpenVK) {
    if (!q.trim()) { res.json({ tracks: [] } satisfies SearchResponse); return; }
    try {
      const tracks = await openvkSearchTracks(sessionOpenVK.token, sessionOpenVK.instanceUrl, q);
      res.json({ tracks } satisfies SearchResponse);
    } catch (err) { respondError(res, err, 'Search failed'); }
    return;
  }
  if (!session) {
    res.json({ tracks: searchDemoTracks(q) } satisfies SearchResponse);
    return;
  }
  if (!q.trim()) {
    res.json({ tracks: [] } satisfies SearchResponse);
    return;
  }
  try {
    const tracks = await searchTracks(session.token, q);
    res.json({ tracks } satisfies SearchResponse);
  } catch (err) {
    respondError(res, err, 'Search failed');
  }
});

app.get('/api/bitrate/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (sessionOpenVK) { res.json({ kbps: null } satisfies BitrateResponse); return; }
  const demo = getDemoEntry(id);
  if (demo) { res.json({ kbps: demo.track.bitrateKbps } satisfies BitrateResponse); return; }
  if (!session) { res.json({ kbps: null } satisfies BitrateResponse); return; }
  const kbps = await getBitrate(session.token, id);
  res.json({ kbps } satisfies BitrateResponse);
});

app.get('/api/wave', async (req: Request, res: Response) => {
  const rawAfter = req.query.after;
  const after = typeof rawAfter === 'string' && rawAfter ? rawAfter : undefined;
  if (sessionOpenVK) {
    res.status(501).json({ error: 'My Wave is not available in OpenVK mode' } satisfies ApiError);
    return;
  }
  if (!session) {
    res.json({ tracks: simulatedWave(after), sessionId: 'demo-wave' } satisfies WaveResponse);
    return;
  }
  try {
    const batch = await fetchWave(session.token, after);
    res.json(batch satisfies WaveResponse);
  } catch (err) {
    respondError(res, err, 'My Wave failed');
  }
});

app.post('/api/wave/feedback', async (req: Request, res: Response) => {
  const body = req.body as Partial<WaveFeedbackRequest> | undefined;
  const trackId = typeof body?.trackId === 'string' ? body.trackId : '';
  const event = body?.event;
  if (!trackId || (event !== 'trackStarted' && event !== 'trackFinished' && event !== 'skip')) {
    res.status(400).json({ error: 'Invalid wave feedback payload' } satisfies ApiError);
    return;
  }
  // Best-effort: demo mode is a no-op, and yandex feedback never fails the client.
  if (session) {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : null;
    void sendWaveFeedback(session.token, event, trackId, sessionId, body?.totalPlayedSeconds);
  }
  res.status(204).end();
});

app.get('/api/stream/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const demo = getDemoEntry(id);
  if (demo) { serveBufferWithRange(req, res, demo.wav, 'audio/wav'); return; }
  if (sessionOpenVK) {
    try {
      const url = await openvkResolveStreamUrl(sessionOpenVK.token, sessionOpenVK.instanceUrl, id);
      await proxyStream(req, res, url);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      respondError(res, err, 'Stream failed');
    }
    return;
  }
  if (!session) {
    res.status(404).json({ error: `Unknown track id: ${id}` } satisfies ApiError);
    return;
  }
  try {
    const url = await resolveStreamUrl(session.token, id);
    await proxyStream(req, res, url);
  } catch (err) {
    if (res.headersSent) {
      // Body already streaming — nothing sensible to send; log and cut off.
      console.error(`[stream] ${id} aborted mid-stream: ${errorMessage(err)}`);
      res.destroy();
      return;
    }
    respondError(res, err, 'Stream failed');
  }
});

app.get('/api/playlists', async (_req: Request, res: Response) => {
  if (sessionOpenVK) {
    try {
      const playlists = await openvkFetchPlaylists(sessionOpenVK.token, sessionOpenVK.uid, sessionOpenVK.instanceUrl);
      res.json({ playlists } satisfies PlaylistsResponse);
    } catch (err) { respondError(res, err, 'Playlists failed'); }
    return;
  }
  if (!session) {
    res.json({ playlists: demoPlaylists() } satisfies PlaylistsResponse);
    return;
  }
  try {
    const playlists = await fetchPlaylists(session.token, session.uid);
    res.json({ playlists } satisfies PlaylistsResponse);
  } catch (err) {
    respondError(res, err, 'Playlists failed');
  }
});

app.get('/api/playlists/:id/tracks', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (sessionOpenVK) {
    try {
      const tracks = await openvkFetchPlaylistTracks(sessionOpenVK.token, sessionOpenVK.uid, id, sessionOpenVK.instanceUrl);
      res.json({ tracks } satisfies PlaylistTracksResponse);
    } catch (err) { respondError(res, err, 'Playlist tracks failed'); }
    return;
  }
  if (!session) {
    const tracks = demoPlaylistTracks(id);
    if (!tracks) {
      res.status(404).json({ error: `Unknown playlist id: ${id}` } satisfies ApiError);
      return;
    }
    res.json({ tracks } satisfies PlaylistTracksResponse);
    return;
  }
  try {
    const tracks = await fetchPlaylistTracks(session.token, session.uid, id);
    res.json({ tracks } satisfies PlaylistTracksResponse);
  } catch (err) {
    respondError(res, err, 'Playlist tracks failed');
  }
});

app.get('/api/liked-ids', async (_req: Request, res: Response) => {
  if (sessionOpenVK) {
    try {
      const ids = await openvkFetchLikedIds(sessionOpenVK.token, sessionOpenVK.uid, sessionOpenVK.instanceUrl);
      res.json({ ids } satisfies LikedIdsResponse);
    } catch (err) { respondError(res, err, 'Liked ids failed'); }
    return;
  }
  if (!session) {
    res.json({ ids: [] } satisfies LikedIdsResponse);
    return;
  }
  try {
    const ids = await fetchLikedIds(session.token, session.uid);
    res.json({ ids } satisfies LikedIdsResponse);
  } catch (err) {
    respondError(res, err, 'Liked ids failed');
  }
});

app.post('/api/like', async (req: Request, res: Response) => {
  const body = req.body as Partial<LikeRequest> | undefined;
  const trackId = typeof body?.trackId === 'string' ? body.trackId : '';
  const liked = body?.liked;
  if (!trackId || typeof liked !== 'boolean') { res.status(400).json({ error: 'Invalid like payload' } satisfies ApiError); return; }
  if (sessionOpenVK) {
    try {
      await openvkLikeTrack(sessionOpenVK.token, sessionOpenVK.uid, trackId, liked, sessionOpenVK.instanceUrl);
      res.json({ liked } satisfies LikeResponse);
    } catch (err) { respondError(res, err, 'Like failed'); }
    return;
  }
  if (!session) {
    // Demo mode: no account to like against — echo the requested state.
    res.json({ liked } satisfies LikeResponse);
    return;
  }
  try {
    await likeTrack(session.token, session.uid, trackId, liked);
    res.json({ liked } satisfies LikeResponse);
  } catch (err) {
    respondError(res, err, 'Like failed');
  }
});

app.post('/api/playlists/create', async (req: Request, res: Response) => {
  if (sessionOpenVK) { res.status(501).json({ error: 'Creating playlists not supported for OpenVK' } satisfies ApiError); return; }
  const body = req.body as Partial<CreatePlaylistRequest> | undefined;
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const trackIds = Array.isArray(body?.trackIds)
    ? body.trackIds.filter((t): t is string => typeof t === 'string')
    : undefined;
  if (!title) {
    res.status(400).json({ error: 'A playlist title is required' } satisfies ApiError);
    return;
  }
  if (!session) {
    res
      .status(409)
      .json({ error: 'Connect a Yandex account to create playlists' } satisfies ApiError);
    return;
  }
  try {
    const playlist: PlaylistSummary = await createPlaylist(session.token, session.uid, title, trackIds);
    res.json(playlist satisfies PlaylistSummary);
  } catch (err) {
    respondError(res, err, 'Create playlist failed');
  }
});

app.post('/api/playlists/:id/add', async (req: Request, res: Response) => {
  if (sessionOpenVK) { res.status(501).json({ error: 'Adding to playlists not supported for OpenVK' } satisfies ApiError); return; }
  const id = req.params.id as string;
  const body = req.body as Partial<{ trackIds: unknown }> | undefined;
  const trackIds = Array.isArray(body?.trackIds)
    ? body.trackIds.filter((t): t is string => typeof t === 'string')
    : [];
  if (trackIds.length === 0) {
    res.status(400).json({ error: 'trackIds required' } satisfies ApiError);
    return;
  }
  if (id === 'liked') {
    res.status(400).json({ error: 'Use the heart to like tracks' } satisfies ApiError);
    return;
  }
  if (!session) {
    res
      .status(409)
      .json({ error: 'Connect a Yandex account to edit playlists' } satisfies ApiError);
    return;
  }
  try {
    const playlist: PlaylistSummary = await addToPlaylist(session.token, session.uid, id, trackIds);
    res.json(playlist satisfies PlaylistSummary);
  } catch (err) {
    respondError(res, err, 'Add to playlist failed');
  }
});

// Unknown /api routes → JSON 404 (never the SPA fallback).
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' } satisfies ApiError);
});

// ---------------------------------------------------------------------------
// Static client (production) + SPA fallback
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  console.log(`[static] serving client from ${clientDist}`);
} else {
  console.log(`[static] ${clientDist} not found — API only (run the vite dev client separately)`);
}

// Final JSON error handler (e.g. malformed JSON body).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[error] ${errorMessage(err)}`);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status =
    err instanceof UpstreamError || err instanceof OpenVkUpstreamError
      ? err.status
      : typeof (err as { status?: unknown }).status === 'number'
        ? ((err as { status: number }).status)
        : 500;
  res.status(status).json({ error: errorMessage(err) } satisfies ApiError);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function respondError(res: Response, err: unknown, context: string): void {
  const status = err instanceof UpstreamError ? err.status : 502;
  const message = `${context}: ${errorMessage(err)}`;
  console.error(`[error] ${message}`);
  res.status(status).json({ error: message } satisfies ApiError);
}

type ParsedRange = { start: number; end: number } | 'unsatisfiable' | null;

/** Parses a single-range `bytes=` header. null → serve the whole resource. */
function parseRange(header: string, size: number): ParsedRange {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // malformed or multi-range: ignore per RFC 9110
  const startStr = m[1] as string;
  const endStr = m[2] as string;
  if (!startStr && !endStr) return null;
  if (!startStr) {
    // Suffix range: last N bytes.
    const suffix = Number(endStr);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startStr);
  if (start >= size) return 'unsatisfiable';
  const end = endStr ? Math.min(Number(endStr), size - 1) : size - 1;
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

function serveBufferWithRange(req: Request, res: Response, buf: Buffer, contentType: string): void {
  res.setHeader('Accept-Ranges', 'bytes');
  const rangeHeader = req.headers.range;
  if (typeof rangeHeader === 'string') {
    const range = parseRange(rangeHeader, buf.length);
    if (range === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${buf.length}`);
      res.status(416).json({ error: 'Requested range not satisfiable' } satisfies ApiError);
      return;
    }
    if (range) {
      res.status(206);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${buf.length}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
      res.end(buf.subarray(range.start, range.end + 1));
      return;
    }
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
}

/**
 * Streams the signed upstream URL to the client, relaying status/headers and
 * forwarding Range. Uses node:https (not fetch/undici, which Yandex's edge
 * fingerprint-blocks) and follows a couple of redirects.
 */
function proxyStream(req: Request, res: Response, url: string, redirectsLeft = 3): Promise<void> {
  const headers: Record<string, string> = { 'User-Agent': 'Yandex-Music-API' };
  if (typeof req.headers.range === 'string') headers['Range'] = req.headers.range;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    };
    const upstream = https.get(url, { headers }, (u: IncomingMessage) => {
      // Connected: cancel the connect timeout so the stream may idle while the
      // browser buffers ahead and pauses reading (backpressure) — a long idle is
      // normal for audio playback and must NOT kill the upstream.
      upstream.setTimeout(0);
      const status = u.statusCode ?? 502;
      // Follow redirects (some audio hosts 302 to a CDN edge).
      if (status >= 300 && status < 400 && u.headers.location && redirectsLeft > 0) {
        u.resume();
        settled = true;
        proxyStream(req, res, new URL(u.headers.location, url).toString(), redirectsLeft - 1).then(
          resolve,
          reject,
        );
        return;
      }
      if (status !== 200 && status !== 206 && status !== 416) {
        u.resume();
        finish(new UpstreamError(502, `Audio host responded ${status}`));
        return;
      }
      res.status(status);
      for (const name of ['content-type', 'content-length', 'content-range'] as const) {
        const value = u.headers[name];
        if (value) res.setHeader(name, value);
      }
      if (!u.headers['content-type']) res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Accept-Ranges', u.headers['accept-ranges'] ?? 'bytes');
      if (status === 416) {
        u.resume();
        res.end();
        finish();
        return;
      }
      // Client went away (seek, next track, tab close): drop the upstream. This
      // is a normal end, not an error.
      res.on('close', () => {
        u.destroy();
        finish();
      });
      u.on('error', () => finish());
      u.on('end', () => finish());
      u.pipe(res);
    });
    upstream.on('error', (err) =>
      finish(new UpstreamError(502, `Could not reach audio host: ${errorMessage(err)}`)),
    );
    upstream.setTimeout(15_000, () => upstream.destroy(new Error('audio host connect timed out')));
  });
}

// ---------------------------------------------------------------------------
// Optional .env token: boot straight into yandex mode for a local real-account
// demo. The token is supplied by the user (see scripts/set-token.mjs); it is
// never logged. An invalid/expired token just falls back to demo mode.
// ---------------------------------------------------------------------------
function readEnvToken(): string | null {
  const fromEnv = process.env.YANDEX_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const envPath = path.resolve(__dirname, '../../.env');
  let text: string;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return null; // no .env file — expected in demo-only setups
  }
  for (const line of text.split('\n')) {
    const m = /^\s*YANDEX_TOKEN\s*=\s*(.*)\s*$/.exec(line);
    if (m) {
      const raw = (m[1] as string).trim();
      return raw.replace(/^["']|["']$/g, '') || null;
    }
  }
  return null;
}

function readEnvOpenVK(): {
  username?: string;
  password?: string;
  instanceUrl?: string;
} | null {
  const username = process.env.OPENVK_USERNAME?.trim();
  const password = process.env.OPENVK_PASSWORD?.trim();
  const instanceUrl = process.env.OPENVK_INSTANCE?.trim();
  if (!instanceUrl) {
    const envPath = path.resolve(__dirname, '../../.env');
    let text: string;
    try { text = fs.readFileSync(envPath, 'utf8'); } catch { return null; }
    let envUser = username || null;
    let envPass = password || null;
    let envUrl = instanceUrl || null;
    for (const line of text.split('\n')) {
      if (!envUser) { const m = /^\s*OPENVK_USERNAME\s*=\s*(.*)\s*$/.exec(line); if (m) envUser = (m[1] as string).trim(); }
      if (!envPass) { const m = /^\s*OPENVK_PASSWORD\s*=\s*(.*)\s*$/.exec(line); if (m) envPass = (m[1] as string).trim(); }
      if (!envUrl) { const m = /^\s*OPENVK_INSTANCE\s*=\s*(.*)\s*$/.exec(line); if (m) envUrl = (m[1] as string).trim().replace(/^["']|["']$/g, '') || null; }
    }
    if (!envUrl) return null;
    return { username: envUser || undefined, password: envPass || undefined, instanceUrl: envUrl };
  }
  return { username: username || undefined, password: password || undefined, instanceUrl };
}

async function bootstrapSession(): Promise<void> {
  cachedYandexToken = readEnvToken();
  const envOvk = readEnvOpenVK();
  cachedOpenVkCreds = envOvk?.instanceUrl
    ? { username: envOvk.username, password: envOvk.password, instanceUrl: envOvk.instanceUrl }
    : null;

  if (cachedYandexToken) {
    try {
      const account = await validateToken(cachedYandexToken);
      if (account) { session = { token: cachedYandexToken, login: account.login, uid: account.uid }; console.log(`[auth] Yandex mode for "${account.login}"`); return; }
      console.warn('[auth] YANDEX_TOKEN rejected (expired?)');
    } catch (err) { console.warn(`[auth] Yandex: ${errorMessage(err)}`); }
  }

  if (cachedOpenVkCreds) {
    const instanceUrl = normaliseInstanceUrl(cachedOpenVkCreds.instanceUrl);
    const c = cachedOpenVkCreds;

    if (c.username && c.password) {
      try {
        const result = await openvkDirectLogin(c.username, c.password, instanceUrl);
        if (result) {
          console.log(`[auth] OpenVK direct login ok for "${result.login}"`);
          sessionOpenVK = { token: result.token, login: result.login, uid: result.uid, instanceUrl };
          return;
        }
        console.warn('[auth] OpenVK direct login rejected');
      } catch (err) { console.warn(`[auth] OpenVK direct login: ${openvkErrorMessage(err)}`); }
    } else {
      console.warn('[auth] OpenVK: OPENVK_USERNAME + OPENVK_PASSWORD required');
    }
  }

  console.log('[auth] no valid tokens — demo mode');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const port = Number(process.env.PORT) || 8058;
void bootstrapSession().finally(() => {
  app.listen(port, () => {
    let mode: string;
    if (sessionOpenVK) mode = `openvk (${sessionOpenVK.login})`;
    else if (session) mode = `yandex (${session.login})`;
    else mode = 'demo';
    console.log(`[web-namp] server listening on http://localhost:${port} (mode: ${mode})`);
  });
});
