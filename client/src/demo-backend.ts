/**
 * In-browser demo backend for the static (GitHub Pages) build.
 *
 * This is a faithful browser port of `server/src/demo.ts`: the same 6-track
 * procedural catalog and WAV synthesizer, plus browser equivalents of every
 * /api endpoint the client uses. It lets the whole app run end-to-end with no
 * server at all — search, playlists, My Wave, EQ and *real synthesized audio*.
 *
 * Only api.ts imports this, and only when `import.meta.env.VITE_STATIC` is set,
 * so a normal (server-backed) build never touches it.
 *
 * Differences from the server module (all browser-safety, not behaviour):
 *  - `encodeWav` returns a `Uint8Array` built with `ArrayBuffer`/`DataView`
 *    instead of a Node `Buffer`.
 *  - audio is synthesized lazily on first stream request and served via a
 *    per-track `blob:` object URL (same-origin → seeking + WebAudio analyser
 *    work exactly as with the server's Range-capable /api/stream/:id).
 *  - track metadata is derived from each song's spec with the same formulas the
 *    server uses, so durations/bitrates match without rendering audio up front.
 */
import type {
  LikedIdsResponse,
  LikeResponse,
  PlaylistsResponse,
  PlaylistSummary,
  PlaylistTracksResponse,
  SearchResponse,
  StatusResponse,
  TokenResponse,
  Track,
  WaveResponse,
} from '@shared';

const SAMPLE_RATE = 44100;
const BEATS_PER_BAR = 4;

type Wave = 'sine' | 'soft' | 'triangle' | 'pulse';

interface SongSpec {
  bpm: number;
  bars: number;
  /** One chord per bar, cycled. Note names like 'C4', 'F#3', 'Bb2'. */
  chords: string[][];
  /** Lead/arp waveform. */
  wave: Wave;
  stereo: boolean;
  /** 2 = eighth-note arpeggio, 4 = sixteenths. */
  arpStepsPerBeat: number;
}

interface SongDef {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  spec: SongSpec;
}

const SONGS: SongDef[] = [
  {
    id: 'demo-1',
    title: 'Sunrise in C',
    artist: 'The Demo Daemons',
    album: 'Placeholder Paradise',
    spec: {
      bpm: 112,
      bars: 12,
      wave: 'soft',
      stereo: true,
      arpStepsPerBeat: 2,
      chords: [
        ['C4', 'E4', 'G4'],
        ['A3', 'C4', 'E4'],
        ['F3', 'A3', 'C4'],
        ['G3', 'B3', 'D4'],
      ],
    },
  },
  {
    id: 'demo-2',
    title: 'Cassette Sky',
    artist: 'Winona & The Amps',
    album: 'Rewind Forever',
    spec: {
      bpm: 92,
      bars: 10,
      wave: 'triangle',
      stereo: true,
      arpStepsPerBeat: 2,
      chords: [
        ['A3', 'C4', 'E4'],
        ['F3', 'A3', 'C4'],
        ['C4', 'E4', 'G4'],
        ['G3', 'B3', 'D4'],
      ],
    },
  },
  {
    id: 'demo-3',
    title: 'Dial-Up Dreams',
    artist: 'Modem Choir',
    album: 'Handshake Hymns',
    spec: {
      bpm: 76,
      bars: 8,
      wave: 'sine',
      stereo: false,
      arpStepsPerBeat: 2,
      chords: [
        ['D3', 'F3', 'A3', 'C4'],
        ['Bb2', 'D3', 'F3', 'A3'],
        ['F3', 'A3', 'C4', 'E4'],
        ['C3', 'E3', 'G3', 'Bb3'],
      ],
    },
  },
  {
    id: 'demo-4',
    title: 'Pixel Rain',
    artist: '8-Bit Bakery',
    album: 'Chiptune Snacks',
    spec: {
      bpm: 132,
      bars: 14,
      wave: 'pulse',
      stereo: true,
      arpStepsPerBeat: 4,
      chords: [
        ['E4', 'G4', 'B4'],
        ['C4', 'E4', 'G4'],
        ['G4', 'B4', 'D5'],
        ['D4', 'F#4', 'A4'],
      ],
    },
  },
  {
    id: 'demo-5',
    title: 'Midnight Vector',
    artist: 'Vector Foxes',
    album: null,
    spec: {
      bpm: 100,
      bars: 11,
      wave: 'soft',
      stereo: true,
      arpStepsPerBeat: 2,
      chords: [
        ['D4', 'F4', 'A4'],
        ['Bb3', 'D4', 'F4'],
        ['G3', 'Bb3', 'D4'],
        ['A3', 'C#4', 'E4'],
      ],
    },
  },
  {
    id: 'demo-6',
    title: 'Coffee & Sine Waves',
    artist: 'Oscillator Café',
    album: 'Late Night Frequencies',
    spec: {
      bpm: 84,
      bars: 9,
      wave: 'sine',
      stereo: false,
      arpStepsPerBeat: 2,
      chords: [
        ['G3', 'B3', 'D4'],
        ['E3', 'G3', 'B3'],
        ['C4', 'E4', 'G4'],
        ['D4', 'F#4', 'A4'],
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Synthesis (ported verbatim from server/src/demo.ts)
// ---------------------------------------------------------------------------

const NOTE_INDEX: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4,
  F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

function noteToFreq(name: string): number {
  const m = /^([A-G][#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`Bad note name: ${name}`);
  const semitone = NOTE_INDEX[m[1] as string];
  if (semitone === undefined) throw new Error(`Bad note name: ${name}`);
  const midi = (Number(m[2]) + 1) * 12 + semitone;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function osc(wave: Wave, phase: number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(phase);
    case 'soft':
      // Sine with gentle 2nd/3rd harmonics — warm electric-piano-ish tone.
      return (Math.sin(phase) + 0.35 * Math.sin(2 * phase) + 0.15 * Math.sin(3 * phase)) / 1.5;
    case 'triangle':
      return (2 / Math.PI) * Math.asin(Math.sin(phase));
    case 'pulse':
      // Soft-clipped sine — chiptune flavour without harsh aliasing.
      return Math.tanh(2.5 * Math.sin(phase));
  }
}

interface NoteEvent {
  startSec: number;
  durSec: number;
  freq: number;
  amp: number;
  wave: Wave;
  /** -1 (left) .. 1 (right). Ignored for mono renders. */
  pan: number;
  /** true: organ-like hold with fade edges; false: plucky decay. */
  sustained: boolean;
}

/** Up-down arpeggio index: 0 1 2 3 2 1 0 1 2 ... */
function arpIndex(step: number, len: number): number {
  if (len <= 1) return 0;
  const period = len * 2 - 2;
  const k = step % period;
  return k < len ? k : period - k;
}

function buildEvents(spec: SongSpec): NoteEvent[] {
  const events: NoteEvent[] = [];
  const beatSec = 60 / spec.bpm;
  const barSec = BEATS_PER_BAR * beatSec;
  const stepSec = beatSec / spec.arpStepsPerBeat;
  const stepsPerBar = BEATS_PER_BAR * spec.arpStepsPerBeat;

  for (let bar = 0; bar < spec.bars; bar++) {
    const chord = spec.chords[bar % spec.chords.length] as string[];
    const chordFreqs = chord.map(noteToFreq);
    const rootFreq = chordFreqs[0] as number;
    const barStart = bar * barSec;

    // Arpeggio: chord tones plus the octave of the root, up-down pattern.
    const arpFreqs = [...chordFreqs, rootFreq * 2];
    for (let step = 0; step < stepsPerBar; step++) {
      events.push({
        startSec: barStart + step * stepSec,
        durSec: stepSec * 0.92,
        freq: arpFreqs[arpIndex(step, arpFreqs.length)] as number,
        amp: 0.2,
        wave: spec.wave,
        pan: spec.stereo ? (step % 2 === 0 ? -0.35 : 0.35) : 0,
        sustained: false,
      });
    }

    // Bass: root an octave down on beats 1 and 3.
    for (const beat of [0, 2]) {
      events.push({
        startSec: barStart + beat * beatSec,
        durSec: beatSec * 1.7,
        freq: rootFreq / 2,
        amp: 0.3,
        wave: 'sine',
        pan: 0,
        sustained: false,
      });
    }

    // Pad: quiet sustained chord for warmth.
    chordFreqs.forEach((freq, i) => {
      const spread = (i - (chordFreqs.length - 1) / 2) * 0.4;
      events.push({
        startSec: barStart,
        durSec: barSec * 0.98,
        freq,
        amp: 0.05,
        wave: 'sine',
        pan: spec.stereo ? Math.max(-0.6, Math.min(0.6, spread)) : 0,
        sustained: true,
      });
    });
  }
  return events;
}

function renderChannels(spec: SongSpec): Float32Array[] {
  const beatSec = 60 / spec.bpm;
  const totalSec = spec.bars * BEATS_PER_BAR * beatSec + 0.3; // small tail
  const frames = Math.floor(totalSec * SAMPLE_RATE);
  const channels: Float32Array[] = spec.stereo
    ? [new Float32Array(frames), new Float32Array(frames)]
    : [new Float32Array(frames)];

  for (const e of buildEvents(spec)) {
    const start = Math.floor(e.startSec * SAMPLE_RATE);
    const dur = Math.max(1, Math.floor(e.durSec * SAMPLE_RATE));
    const attack = Math.max(1, Math.floor(Math.min(0.012, e.durSec / 4) * SAMPLE_RATE));
    const release = Math.max(1, Math.floor(0.08 * SAMPLE_RATE));
    const omega = (2 * Math.PI * e.freq) / SAMPLE_RATE;
    // Equal-power pan.
    const p = (e.pan + 1) / 2;
    const gainL = spec.stereo ? Math.cos((p * Math.PI) / 2) : 1;
    const gainR = Math.sin((p * Math.PI) / 2);

    for (let i = 0; i < dur && start + i < frames; i++) {
      const env = e.sustained
        ? Math.min(1, i / attack, (dur - i) / release)
        : Math.min(1, i / attack) * Math.pow(1 - i / dur, 1.35);
      const v = osc(e.wave, omega * i) * env * e.amp;
      (channels[0] as Float32Array)[start + i] += v * gainL;
      if (spec.stereo) (channels[1] as Float32Array)[start + i] += v * gainR;
    }
  }

  // Master fade in/out to avoid clicks, then normalize to a safe peak.
  const fadeIn = Math.floor(0.03 * SAMPLE_RATE);
  const fadeOut = Math.floor(0.4 * SAMPLE_RATE);
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < frames; i++) {
      if (i < fadeIn) ch[i] = (ch[i] as number) * (i / fadeIn);
      if (i > frames - fadeOut) ch[i] = (ch[i] as number) * ((frames - i) / fadeOut);
      const a = Math.abs(ch[i] as number);
      if (a > peak) peak = a;
    }
  }
  if (peak > 0) {
    const scale = 0.88 / peak;
    for (const ch of channels) {
      for (let i = 0; i < frames; i++) ch[i] = (ch[i] as number) * scale;
    }
  }
  return channels;
}

/**
 * Browser-safe WAV encoder — same 44-byte PCM header + interleaved 16-bit
 * samples as the server's `encodeWav`, but written into an `ArrayBuffer` via a
 * `DataView` (no Node `Buffer`). Returns the raw bytes for a `Blob`.
 */
function encodeWav(channels: Float32Array[]): Uint8Array<ArrayBuffer> {
  const numCh = channels.length;
  const frames = (channels[0] as Float32Array).length;
  const dataSize = frames * numCh * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * numCh * 2, true); // byte rate
  view.setUint16(32, numCh * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, (channels[c] as Float32Array)[i] as number));
      view.setInt16(o, Math.round(s * 32767), true);
      o += 2;
    }
  }
  return new Uint8Array(buffer);
}

// ---------------------------------------------------------------------------
// Catalog metadata (derived from each spec, matching the server's formulas)
// ---------------------------------------------------------------------------

/** Total rendered frame count for a spec — mirrors renderChannels() exactly. */
function frameCount(spec: SongSpec): number {
  const beatSec = 60 / spec.bpm;
  const totalSec = spec.bars * BEATS_PER_BAR * beatSec + 0.3;
  return Math.floor(totalSec * SAMPLE_RATE);
}

function toTrack(song: SongDef): Track {
  const channels = song.spec.stereo ? 2 : 1;
  const frames = frameCount(song.spec);
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    durationMs: Math.round((frames / SAMPLE_RATE) * 1000),
    bitrateKbps: Math.round((SAMPLE_RATE * 16 * channels) / 1000),
  };
}

// Lazily built (and memoized) so nothing in this module runs at import time.
// That keeps the module fully tree-shakeable: a normal (non-static) build,
// where api.ts never calls into here, drops it entirely.
let songById: Map<string, SongDef> | null = null;
function songLookup(id: string): SongDef | undefined {
  if (!songById) songById = new Map(SONGS.map((s) => [s.id, s]));
  return songById.get(id);
}

let catalogCache: Track[] | null = null;
function catalog(): Track[] {
  if (!catalogCache) catalogCache = SONGS.map(toTrack);
  return catalogCache;
}

/** Empty query returns the full catalog (used to pre-fill the playlist). */
function searchCatalog(q: string): Track[] {
  const tracks = catalog();
  const needle = q.trim().toLowerCase();
  if (!needle) return tracks;
  return tracks.filter(
    (t) => t.title.toLowerCase().includes(needle) || t.artist.toLowerCase().includes(needle),
  );
}

/** The "Chill Selection" subset — the slower, mellower demo tracks. */
const CHILL_IDS = ['demo-3', 'demo-5', 'demo-6'];

function demoPlaylists(): PlaylistSummary[] {
  return [
    { id: 'demo-all', title: 'All Demo Tracks', trackCount: catalog().length },
    { id: 'demo-chill', title: 'Chill Selection', trackCount: CHILL_IDS.length },
  ];
}

/** Tracks for a demo playlist id, or null if the id is unknown. */
function demoPlaylistTracks(id: string): Track[] | null {
  if (id === 'demo-all') return catalog();
  if (id === 'demo-chill') return catalog().filter((t) => CHILL_IDS.includes(t.id));
  return null;
}

/**
 * A simulated "Моя волна" batch drawn from the demo catalog. Returns a shuffled
 * run of tracks that never starts with `afterId` (the track that just played)
 * and never repeats back-to-back — mirrors the server's `simulatedWave`.
 */
function simulatedWave(afterId?: string): Track[] {
  const base = catalog().filter((t) => t.id !== afterId);
  const out: Track[] = [];
  const TARGET = 22; // deep queue, like the real wave — repeats the small catalog
  while (out.length < TARGET && base.length > 0) {
    const round = base.slice();
    for (let i = round.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [round[i], round[j]] = [round[j] as Track, round[i] as Track];
    }
    for (const t of round) {
      if (out.length > 0 && out[out.length - 1]?.id === t.id) continue; // no back-to-back repeat
      out.push(t);
      if (out.length >= TARGET) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lazy audio: synthesize each track's WAV on first request and cache its
// blob: object URL. Blob URLs are same-origin so <audio> seeking and the
// WebAudio analyser work without CORS trouble.
// ---------------------------------------------------------------------------

const objectUrlCache = new Map<string, string>();

function getObjectUrl(id: string): string {
  const cached = objectUrlCache.get(id);
  if (cached) return cached;
  const song = songLookup(id);
  if (!song) throw new Error(`Unknown track id: ${id}`);
  const bytes = encodeWav(renderChannels(song.spec));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  objectUrlCache.set(id, url);
  return url;
}

// ---------------------------------------------------------------------------
// Demo equivalents of the /api endpoints (same contract as server/src/index.ts)
// ---------------------------------------------------------------------------

/** GET /api/status → always demo, no account. */
export function getStatus(): Promise<StatusResponse> {
  return Promise.resolve({ mode: 'demo', account: null });
}

/** POST /api/token → rejected: there is no server to talk to Yandex. */
export function submitToken(_token: string): Promise<TokenResponse> {
  return Promise.reject(
    new Error('demo build — connect a Yandex account by running web-namp locally'),
  );
}

/** GET /api/search → filter the catalog (empty query → all tracks). */
export function searchTracks(q: string): Promise<SearchResponse> {
  return Promise.resolve({ tracks: searchCatalog(q) });
}

/** Blob object URL for a demo track, synthesized (and cached) on demand. */
export function streamUrl(id: string): string {
  return getObjectUrl(id);
}

/** GET /api/playlists → the two demo playlists. */
export function getPlaylists(): Promise<PlaylistsResponse> {
  return Promise.resolve({ playlists: demoPlaylists() });
}

/** GET /api/playlists/:id/tracks → the playlist's tracks, or a 404-equivalent. */
export function getPlaylistTracks(id: string): Promise<PlaylistTracksResponse> {
  const tracks = demoPlaylistTracks(id);
  if (!tracks) return Promise.reject(new Error(`Unknown playlist id: ${id}`));
  return Promise.resolve({ tracks });
}

/** GET /api/liked-ids → nothing liked in the demo. */
export function getLikedIds(): Promise<LikedIdsResponse> {
  return Promise.resolve({ ids: [] });
}

/** POST /api/like → echo the requested state (no account to like against). */
export function setLike(_trackId: string, liked: boolean): Promise<LikeResponse> {
  return Promise.resolve({ liked });
}

/** POST /api/playlists/create → rejected in the demo. */
export function createPlaylist(_title: string, _trackIds?: string[]): Promise<PlaylistSummary> {
  return Promise.reject(new Error('demo build — run web-namp locally to create playlists'));
}

/** POST /api/playlists/:id/add → rejected in the demo. */
export function addToPlaylist(_id: string, _trackIds: string[]): Promise<PlaylistSummary> {
  return Promise.reject(new Error('demo build — run web-namp locally to edit playlists'));
}

/** GET /api/wave → a simulated, effectively-infinite wave from the catalog. */
export function getWave(after?: string): Promise<WaveResponse> {
  return Promise.resolve({ tracks: simulatedWave(after), sessionId: 'demo-wave' });
}
