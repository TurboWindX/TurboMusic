/**
 * "Make duet": Claude turns an imported tab into a two-part arrangement:
 * a beginner chord chart (rhythm player) + a single-line melody tab (lead player),
 * written in the app's own text formats so the existing parsers can play them.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface ArrangeInput {
  title: string;
  artist?: string;
  tab: string;
  chordChart?: string;
  bpm?: number;
  beatsPerBar?: number;
  capo?: number;
}

export interface Arrangement {
  bpm: number;
  beatsPerBar: number;
  melodyStartBar: number;
  strumPattern: string;
  chordChart: string;
  melodyTab: string;
  suggestedChordCapo: number;
  notes: string;
}

export class ArrangeError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

const MODEL = 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bpm', 'beatsPerBar', 'melodyStartBar', 'strumPattern', 'chordChart', 'melodyTab', 'suggestedChordCapo', 'notes'],
  properties: {
    bpm: { type: 'integer', description: 'Tempo in quarter-note beats per minute.' },
    beatsPerBar: { type: 'integer', description: 'Beats per bar, usually 4 or 3.' },
    melodyStartBar: { type: 'integer', description: '1-based bar where the melody tab starts (chords may have an intro before it). Usually 1.' },
    strumPattern: { type: 'string', description: 'One bar of 8th-note strum slots using D, U and -, e.g. "D-D-D-D-" or "D-------". Length = beatsPerBar * 2.' },
    chordChart: { type: 'string', description: 'Chord chart in the app format described in the instructions.' },
    melodyTab: { type: 'string', description: 'Simplified single-line melody as 6-line ASCII tab in the strict grid described in the instructions.' },
    suggestedChordCapo: { type: 'integer', description: 'Extra capo (0-7) for the beginner so the chord shapes are open chords. 0 if not needed.' },
    notes: { type: 'string', description: 'Two or three short sentences for the players: key, feel, anything to watch for.' },
  },
} as const;

const SYSTEM = `You arrange songs as guitar duets for a couple practising together on a TV screen.
Player 1 (lead) can read tab and play simple melodies. Player 2 (rhythm) is a complete beginner who only strums chords.

You receive a guitar tab that the user imported for personal practice. Produce two parts that line up bar for bar:

1. chordChart (for the beginner). Format, one bar per "|" cell:
   [Section name]
   | Am | F | C | G |
   - Use section headers like [Intro], [Theme], [Bridge] where the music changes.
   - Two chords in one cell split the bar evenly ("| C G |"). Keep to at most two chords per bar; one is better.
   - Prefer plain triads and simple sevenths (no slash chords, no 9/11/13). Spell chords as sounding pitch, ignoring any capo the app applies for the beginner.
   - Every line must be bars only. No lyrics, no prose.

2. melodyTab (for the lead player): the main melody only, one note at a time, playable in open/low positions where possible.
   Strict format so the app can time it:
   - Blocks of exactly 6 lines in order e, B, G, D, A, E, each line starting with the string name and "|", e.g. "e|".
   - Each bar is exactly beatsPerBar*4 characters between bar lines: 2 characters per 8th-note slot. Slot = a fret number padded with "-" to 2 characters ("3-", "10") or "--" for no note.
   - End every bar with "|". Put 4 bars per block, one blank line between blocks. No text inside or between blocks.
   - The total number of melody bars must equal the chord chart bars minus (melodyStartBar - 1).

Base the arrangement on the tab provided. Where the source is a fingerstyle arrangement, take the top melodic line for the lead part and the harmony implied by the bass and inner voices for the chords.
Choose bpm from the source if it states one; otherwise estimate it for the piece.`;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new ArrangeError('No Anthropic API key configured. Put ANTHROPIC_API_KEY in the .env file and restart the server.', 503);
  }
  client ??= new Anthropic();
  return client;
}

export async function arrangeDuet(input: ArrangeInput): Promise<Arrangement> {
  if (!input.tab?.trim()) throw new ArrangeError('The song has no tab to arrange yet. Import or paste one first.', 400);

  const userText = [
    `Song: ${input.title}${input.artist ? ` by ${input.artist}` : ''}`,
    `Current settings: ${input.beatsPerBar ?? 4} beats per bar, ${input.bpm ?? 'unknown'} bpm, capo ${input.capo ?? 0} (as written in the source tab).`,
    input.chordChart?.trim() ? `Chords already in the app (may be auto-detected, may be wrong):\n${input.chordChart}` : '',
    `Source tab:\n<tab>\n${input.tab}\n</tab>`,
  ].filter(Boolean).join('\n\n');

  let message;
  try {
    const stream = getClient().beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA as unknown as Record<string, unknown> } },
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }],
    });
    message = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new ArrangeError('The Anthropic API key was rejected. Check the key in .env.', 401);
    if (e instanceof Anthropic.PermissionDeniedError) throw new ArrangeError('The API key has no access to this model.', 403);
    if (e instanceof Anthropic.RateLimitError) throw new ArrangeError('Rate limited by the Anthropic API. Wait a minute and try again.', 429);
    if (e instanceof Anthropic.APIError) throw new ArrangeError(`Anthropic API error ${e.status ?? ''}: ${e.message}`);
    throw new ArrangeError(`Could not reach the Anthropic API: ${(e as Error).message}`);
  }

  if (message.stop_reason === 'refusal') throw new ArrangeError('Claude declined to arrange this tab.', 422);
  if (message.stop_reason === 'max_tokens') throw new ArrangeError('The arrangement was too long and got cut off. Try a shorter tab.', 422);

  const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ArrangeError('Claude returned something that was not valid JSON.');
  }
  return validate(raw);
}

function validate(raw: unknown): Arrangement {
  const r = raw as Record<string, unknown>;
  const int = (k: string, lo: number, hi: number, dflt: number) =>
    typeof r[k] === 'number' && Number.isFinite(r[k]) ? Math.min(hi, Math.max(lo, Math.round(r[k] as number))) : dflt;
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
  const out: Arrangement = {
    bpm: int('bpm', 20, 300, 80),
    beatsPerBar: int('beatsPerBar', 1, 12, 4),
    melodyStartBar: int('melodyStartBar', 1, 999, 1),
    strumPattern: str('strumPattern').toUpperCase().replace(/[^DU-]/g, '') || 'D-------',
    chordChart: str('chordChart'),
    melodyTab: str('melodyTab'),
    suggestedChordCapo: int('suggestedChordCapo', 0, 7, 0),
    notes: str('notes').slice(0, 2000),
  };
  if (!out.chordChart.trim() || !out.melodyTab.trim()) throw new ArrangeError('Claude returned an empty part. Try again.');
  return out;
}
