/**
 * TurboMusic API + static server.
 *
 *   GET    /api/songs        list summaries
 *   GET    /api/songs/:id    one song
 *   POST   /api/songs        create (id generated from title)
 *   PUT    /api/songs/:id    create/replace
 *   DELETE /api/songs/:id
 *
 * Songs live as JSON files in data/songs (override with DATA_DIR).
 * In production (after `npm run build`) it also serves dist/ on the same port.
 * Set APP_PASSWORD (and optionally APP_USER) to require HTTP basic auth —
 * do this before exposing the app through a tunnel.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { normalizeSong, type Song, type SongSummary } from '../shared/types.ts';
import { DEMO_SONG } from '../shared/demoSong.ts';
import { ImportError, importFromUrl } from './importer.ts';
import { ArrangeError, arrangeDuet } from './arranger.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Secrets (ANTHROPIC_API_KEY, APP_PASSWORD) live in .env, which git ignores.
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data', 'songs'));
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// ------------------------------------------------------------ optional auth
const PASSWORD = process.env.APP_PASSWORD;
const USER = process.env.APP_USER ?? 'guitar';
if (PASSWORD) {
  const expected = Buffer.from(`${USER}:${PASSWORD}`);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const hdr = req.headers.authorization ?? '';
    const given = hdr.startsWith('Basic ') ? Buffer.from(hdr.slice(6), 'base64') : Buffer.alloc(0);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="TurboMusic"').status(401).send('Auth required');
  });
}

// ------------------------------------------------------------ storage
const fileFor = (id: string) => path.join(DATA_DIR, `${id}.json`);

async function readSong(id: string): Promise<Song | null> {
  try {
    return normalizeSong({ ...JSON.parse(await readFile(fileFor(id), 'utf8')), id });
  } catch {
    return null;
  }
}

async function writeSong(song: Song) {
  const tmp = fileFor(song.id) + '.tmp';
  await writeFile(tmp, JSON.stringify(song, null, 2), 'utf8');
  await rename(tmp, fileFor(song.id));
}

function slugify(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'song';
}

/** Accept only known fields with sane types. */
function sanitize(body: unknown, id: string): Song | string {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object';
  const b = body as Record<string, unknown>;
  const str = (k: string, max: number) => (typeof b[k] === 'string' ? (b[k] as string).slice(0, max) : undefined);
  const num = (k: string, lo: number, hi: number) =>
    typeof b[k] === 'number' && Number.isFinite(b[k]) ? Math.min(hi, Math.max(lo, b[k] as number)) : undefined;
  const song: Partial<Song> & { id: string } = { id };
  const fields: Partial<Song> = {
    title: str('title', 200),
    artist: str('artist', 200),
    notes: str('notes', 5000),
    chordChart: str('chordChart', 100_000),
    tab: str('tab', 400_000),
    originalTab: str('originalTab', 400_000),
    strumPattern: str('strumPattern', 32),
    bpm: num('bpm', 20, 300),
    beatsPerBar: num('beatsPerBar', 1, 12),
    capo: num('capo', 0, 12),
    tabGrid: num('tabGrid', 1, 8),
    melodyStartBar: num('melodyStartBar', 1, 999),
  };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) (song as Record<string, unknown>)[k] = v;
  if (!song.title?.trim()) return 'title is required';
  return { ...normalizeSong(song), updatedAt: new Date().toISOString() };
}

// ------------------------------------------------------------ routes
const api = express.Router();

api.get('/songs', async (_req, res) => {
  const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.json'));
  const songs = await Promise.all(files.map((f) => readSong(f.slice(0, -5))));
  const list: SongSummary[] = songs
    .filter((s): s is Song => !!s)
    .map(({ id, title, artist, updatedAt }) => ({ id, title, artist, updatedAt }))
    .sort((a, b) => a.title.localeCompare(b.title));
  res.json(list);
});

api.get('/songs/:id', async (req, res) => {
  const { id } = req.params;
  const song = ID_RE.test(id) ? await readSong(id) : null;
  if (!song) return void res.status(404).json({ error: 'Not found' });
  res.json(song);
});

api.post('/songs', async (req, res) => {
  const base = slugify(String((req.body as { title?: string })?.title ?? 'song'));
  let id = base;
  for (let i = 2; existsSync(fileFor(id)); i++) id = `${base}-${i}`;
  const song = sanitize(req.body, id);
  if (typeof song === 'string') return void res.status(400).json({ error: song });
  await writeSong(song);
  res.status(201).json(song);
});

api.put('/songs/:id', async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return void res.status(400).json({ error: 'Bad id' });
  const song = sanitize(req.body, id);
  if (typeof song === 'string') return void res.status(400).json({ error: song });
  await writeSong(song);
  res.json(song);
});

api.delete('/songs/:id', async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return void res.status(400).json({ error: 'Bad id' });
  try {
    await unlink(fileFor(id));
    res.status(204).end();
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

/** Feature flags the UI needs. */
api.get('/config', (_req, res) => void res.json({ claude: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) }));

/** Fetch a user-chosen tab page and return song fields (does not save). */
api.post('/import', async (req, res) => {
  const url = (req.body as { url?: unknown })?.url;
  if (typeof url !== 'string') return void res.status(400).json({ error: 'url is required' });
  try {
    res.json(await importFromUrl(url));
  } catch (e) {
    if (e instanceof ImportError) return void res.status(422).json({ error: e.message });
    throw e;
  }
});

/** Ask Claude to turn the song's tab into a chord part + simplified melody (does not save). */
api.post('/arrange', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.tab !== 'string' || typeof b.title !== 'string') return void res.status(400).json({ error: 'title and tab are required' });
  try {
    res.json(await arrangeDuet({
      title: b.title.slice(0, 200),
      artist: typeof b.artist === 'string' ? b.artist.slice(0, 200) : undefined,
      tab: b.tab.slice(0, 100_000),
      chordChart: typeof b.chordChart === 'string' ? b.chordChart.slice(0, 20_000) : undefined,
      bpm: typeof b.bpm === 'number' ? b.bpm : undefined,
      beatsPerBar: typeof b.beatsPerBar === 'number' ? b.beatsPerBar : undefined,
      capo: typeof b.capo === 'number' ? b.capo : undefined,
    }));
  } catch (e) {
    if (e instanceof ArrangeError) return void res.status(e.status).json({ error: e.message });
    throw e;
  }
});

app.use('/api', api);
app.use('/api', (_req, res) => void res.status(404).json({ error: 'Unknown endpoint' }));

if (existsSync(DIST)) {
  app.use(express.static(DIST, { index: false, maxAge: '1y', immutable: true }));
  // index.html must revalidate so a rebuild is picked up; hashed assets can cache.
  app.get('/{*splat}', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(DIST, 'index.html')));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ------------------------------------------------------------ boot
await mkdir(DATA_DIR, { recursive: true });
if (!(await readdir(DATA_DIR)).some((f) => f.endsWith('.json'))) {
  await writeSong({ ...DEMO_SONG, updatedAt: new Date().toISOString() });
  console.log('Seeded demo song');
}

app.listen(PORT, HOST, () => {
  console.log(`TurboMusic API on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(existsSync(DIST) ? 'Serving built app from dist/' : 'No dist/ yet — use `npm run dev` (Vite on :5173)');
  if (!PASSWORD) console.log('Auth: OFF (set APP_PASSWORD before exposing via a tunnel)');
  console.log(process.env.ANTHROPIC_API_KEY ? 'Claude duet arranger: ON' : 'Claude duet arranger: OFF (no ANTHROPIC_API_KEY in .env)');
});
