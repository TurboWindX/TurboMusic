/**
 * Sheet music from a PDF or photos: Claude reads the score and returns every note
 * (experimental; MIDI or MusicXML is exact and preferred when available).
 *
 * Runs as a background job: a few pages can take minutes, longer than a request
 * through a tunnel is allowed to stay open, so the client polls for the result.
 */
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';

const MODEL = 'claude-opus-5-5';
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

export interface UploadFile { name: string; mediaType: string; data: string /* base64 */ }

export interface TranscribedNote { beat: number; duration: number; midi: number; staff: 1 | 2 }
export interface Transcription {
  title: string;
  composer: string;
  bpm: number;
  beatsPerBar: number;
  notes: TranscribedNote[];
  remarks: string;
}

export class TranscribeError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

const EVENT = {
  type: 'object',
  additionalProperties: false,
  required: ['beat', 'duration', 'pitches'],
  properties: {
    beat: { type: 'number', description: 'Start within the measure in quarter notes, 0 = downbeat (e.g. 1.5 = the "and" of beat 2).' },
    duration: { type: 'number', description: 'Length in quarter notes (half = 2, eighth = 0.5, dotted quarter = 1.5, triplet eighth = 0.333).' },
    pitches: { type: 'array', items: { type: 'string' }, description: 'Notes struck together, scientific pitch with accidentals applied, e.g. ["C4","E4","G#4"]. Middle C = C4.' },
  },
} as const;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'composer', 'bpm', 'beatsPerBar', 'measures', 'remarks'],
  properties: {
    title: { type: 'string' },
    composer: { type: 'string', description: 'Empty string if not shown.' },
    bpm: { type: 'integer', description: 'Quarter-note tempo from the marking; estimate from the tempo word (Andante ~ 80, Allegro ~ 130) if no number.' },
    beatsPerBar: { type: 'integer', description: 'Bar length in quarter notes (4/4 = 4, 3/4 = 3, 6/8 = 3, 2/2 = 4).' },
    measures: {
      type: 'array',
      description: 'Every measure in performance order (repeats and 1st/2nd endings written out).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'beats', 'right', 'left'],
        properties: {
          number: { type: 'integer', description: 'Measure number as printed (repeated measures keep their number).' },
          beats: { type: 'number', description: 'Actual length in quarter notes (shorter for a pickup measure).' },
          right: { type: 'array', items: EVENT, description: 'Treble / upper staff (right hand).' },
          left: { type: 'array', items: EVENT, description: 'Bass / lower staff (left hand).' },
        },
      },
    },
    remarks: { type: 'string', description: 'One or two sentences: anything unclear or simplified.' },
  },
} as const;

const SYSTEM = `You transcribe printed piano sheet music into exact note data for a practice app.
The user uploaded these pages from their own collection to practise with.

Rules:
- Read every measure on every page, in order. Expand repeat signs and 1st/2nd endings into performance order. Follow D.C./D.S./Coda instructions when they are clear.
- For each measure give the right hand (upper staff) and left hand (lower staff) as events. An event is everything struck at the same moment in that hand.
- Apply key signature and accidentals (an accidental lasts until the barline). Respect clefs and 8va/8vb marks.
- Ties: write a tied note once, with its full combined length; do not repeat it in the next measure (a tie across the barline extends the earlier event's duration past the measure end).
- Rests are simply gaps (no event). Ignore grace notes, fingerings, pedal marks and dynamics.
- If a passage is impossible to read, give your best reading and mention it in remarks. Never invent extra music.`;

const jobs = new Map<string, { status: 'running' | 'done' | 'error'; started: number; result?: Transcription; error?: string; httpStatus?: number }>();

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new TranscribeError('No Anthropic API key configured. Put ANTHROPIC_API_KEY in the .env file and restart the server.', 503);
  }
  client ??= new Anthropic();
  return client;
}

/** Validates the upload and starts the job; returns its id. */
export function startTranscription(files: UploadFile[]): string {
  if (!Array.isArray(files) || !files.length) throw new TranscribeError('No file uploaded', 400);
  if (files.length > 10) throw new TranscribeError('At most 10 files (pages) at once', 400);
  for (const f of files) {
    if (typeof f?.data !== 'string' || typeof f.mediaType !== 'string') throw new TranscribeError('Bad upload', 400);
    if (f.mediaType !== 'application/pdf' && !IMAGE_TYPES.includes(f.mediaType as ImageType)) {
      throw new TranscribeError(`Unsupported file type ${f.mediaType}: use PDF, PNG, JPEG, GIF or WebP`, 400);
    }
  }
  getClient(); // fail fast without a key
  const id = randomUUID();
  jobs.set(id, { status: 'running', started: Date.now() });
  transcribe(files).then(
    (result) => jobs.set(id, { status: 'done', started: jobs.get(id)!.started, result }),
    (e: unknown) => jobs.set(id, {
      status: 'error',
      started: jobs.get(id)!.started,
      error: e instanceof Error ? e.message : String(e),
      httpStatus: e instanceof TranscribeError ? e.status : 500,
    }),
  );
  // Forget old jobs.
  for (const [k, j] of jobs) if (Date.now() - j.started > 3_600_000) jobs.delete(k);
  return id;
}

export function getJob(id: string) {
  const j = jobs.get(id);
  if (!j) return null;
  return { status: j.status, elapsed: Math.round((Date.now() - j.started) / 1000), result: j.result, error: j.error };
}

async function transcribe(files: UploadFile[]): Promise<Transcription> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = files.map((f) =>
    f.mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: f.name.slice(0, 200) }
      : { type: 'image', source: { type: 'base64', media_type: f.mediaType as ImageType, data: f.data } },
  );
  content.push({ type: 'text', text: files.length > 1 ? `These are ${files.length} pages of one piece, in order. Transcribe the whole piece.` : 'Transcribe this piece.' });

  let message;
  try {
    const stream = getClient().beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA as unknown as Record<string, unknown> } },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    });
    message = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new TranscribeError('The Anthropic API key was rejected. Check the key in .env.', 401);
    if (e instanceof Anthropic.PermissionDeniedError) throw new TranscribeError('The API key has no access to this model.', 403);
    if (e instanceof Anthropic.RateLimitError) throw new TranscribeError('Rate limited by the Anthropic API. Wait a minute and try again.', 429);
    if (e instanceof Anthropic.APIError) throw new TranscribeError(`Anthropic API error ${e.status ?? ''}: ${e.message}`);
    throw new TranscribeError(`Could not reach the Anthropic API: ${(e as Error).message}`);
  }
  if (message.stop_reason === 'refusal') throw new TranscribeError('Claude declined to transcribe this file.', 422);
  if (message.stop_reason === 'max_tokens') throw new TranscribeError('The piece is too long to transcribe in one go. Try fewer pages at a time.', 422);

  const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  let raw: RawResult;
  try {
    raw = JSON.parse(text) as RawResult;
  } catch {
    throw new TranscribeError('Claude returned something that was not valid JSON.');
  }
  return flatten(raw);
}

interface RawEvent { beat: number; duration: number; pitches: string[] }
interface RawResult {
  title: string; composer: string; bpm: number; beatsPerBar: number; remarks: string;
  measures: { number: number; beats: number; right: RawEvent[]; left: RawEvent[] }[];
}

const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function pitchToMidi(p: string): number | null {
  const m = /^([A-Ga-g])(#{1,2}|b{1,2}|x|♯|♭|n)?(-?\d)$/.exec(p.trim());
  if (!m) return null;
  const acc = m[2] ?? '';
  const alter = acc === '#' || acc === '♯' ? 1 : acc === '##' || acc === 'x' ? 2 : acc === 'b' || acc === '♭' ? -1 : acc === 'bb' ? -2 : 0;
  const midi = (Number(m[3]) + 1) * 12 + STEPS[m[1].toUpperCase()] + alter;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/** Measures -> absolute note list (quarter-note beats from the start). */
export function flatten(raw: RawResult): Transcription {
  const bpb = Math.max(1, Math.min(12, Math.round(raw.beatsPerBar) || 4));
  const notes: TranscribedNote[] = [];
  let t = 0;
  raw.measures.forEach((m) => {
    const len = m.beats > 0 && m.beats <= 16 ? m.beats : bpb;
    for (const [staff, events] of [[1, m.right], [2, m.left]] as const) {
      for (const e of events ?? []) {
        if (!(e.duration > 0) || !(e.beat >= 0)) continue;
        for (const p of e.pitches ?? []) {
          const midi = pitchToMidi(p);
          if (midi !== null) notes.push({ beat: t + e.beat, duration: e.duration, midi, staff });
        }
      }
    }
    t += len;
  });
  if (!notes.length) throw new TranscribeError('No notes could be read from this file.', 422);
  return {
    title: raw.title?.slice(0, 200) ?? '',
    composer: raw.composer?.slice(0, 200) ?? '',
    bpm: Math.max(20, Math.min(300, Math.round(raw.bpm) || 90)),
    beatsPerBar: bpb,
    notes: notes.sort((a, b) => a.beat - b.beat || a.midi - b.midi),
    remarks: raw.remarks?.slice(0, 1000) ?? '',
  };
}
