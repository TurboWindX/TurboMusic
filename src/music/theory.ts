/** Note names, chord-name parsing and transposition. */

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** MIDI numbers of open strings, standard tuning, low E -> high e. */
export const STANDARD_TUNING = [40, 45, 50, 55, 59, 64];
export const STRING_LABELS = ['E', 'A', 'D', 'G', 'B', 'e'];

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function pitchClass(name: string): number | null {
  const m = /^([A-Ga-g])([#b]?)$/.exec(name.trim());
  if (!m) return null;
  let pc = LETTER_PC[m[1].toUpperCase()];
  if (m[2] === '#') pc += 1;
  if (m[2] === 'b') pc -= 1;
  return (pc + 12) % 12;
}

export function pcName(pc: number, preferFlats = false): string {
  const i = ((pc % 12) + 12) % 12;
  return (preferFlats ? FLAT_NAMES : SHARP_NAMES)[i];
}

export type Quality =
  | '' | 'm' | '7' | 'm7' | 'maj7' | 'sus2' | 'sus4' | '7sus4' | 'add9'
  | 'dim' | 'dim7' | 'm7b5' | 'aug' | '6' | 'm6' | '9' | 'm9' | 'maj9' | '5';

export interface ParsedChord {
  root: number;
  quality: Quality;
  bass: number | null;
  preferFlats: boolean;
  /** Original text as written. */
  text: string;
}

const QUALITY_ALIASES: Record<string, Quality> = {
  '': '', maj: '', M: '',
  m: 'm', min: 'm', '-': 'm', mi: 'm',
  '7': '7', dom7: '7',
  m7: 'm7', min7: 'm7', '-7': 'm7', mi7: 'm7',
  maj7: 'maj7', M7: 'maj7', 'Δ': 'maj7', 'Δ7': 'maj7', ma7: 'maj7',
  sus2: 'sus2', '2': 'sus2',
  sus4: 'sus4', sus: 'sus4', '4': 'sus4',
  '7sus4': '7sus4', '7sus': '7sus4',
  add9: 'add9', add2: 'add9',
  dim: 'dim', '°': 'dim', o: 'dim',
  dim7: 'dim7', '°7': 'dim7', o7: 'dim7',
  m7b5: 'm7b5', 'ø': 'm7b5', 'ø7': 'm7b5', 'min7b5': 'm7b5',
  aug: 'aug', '+': 'aug',
  '6': '6', m6: 'm6', min6: 'm6',
  '9': '9', m9: 'm9', min9: 'm9', maj9: 'maj9', M9: 'maj9',
  '5': '5',
  // Common extras collapsed onto something playable.
  '11': '7', '13': '7', m11: 'm7', maj13: 'maj7', '7b9': '7', '7#9': '7', 'madd9': 'm',
};

export function parseChord(text: string): ParsedChord | null {
  const t = text.trim();
  const m = /^([A-G])([#b]?)([^/]*?)(?:\/([A-G][#b]?))?$/.exec(t);
  if (!m) return null;
  const root = pitchClass(m[1] + m[2]);
  if (root === null) return null;
  const q = QUALITY_ALIASES[m[3]];
  if (q === undefined) return null;
  const bass = m[4] ? pitchClass(m[4]) : null;
  return { root, quality: q, bass, preferFlats: m[2] === 'b' || (m[4]?.includes('b') ?? false), text: t };
}

export function chordName(c: Pick<ParsedChord, 'root' | 'quality' | 'bass' | 'preferFlats'>): string {
  const base = pcName(c.root, c.preferFlats) + c.quality;
  return c.bass === null ? base : `${base}/${pcName(c.bass, c.preferFlats)}`;
}

export function transposeChord(c: ParsedChord, semis: number): ParsedChord {
  const root = (c.root + semis + 120) % 12;
  const bass = c.bass === null ? null : (c.bass + semis + 120) % 12;
  const t = { ...c, root, bass };
  return { ...t, text: chordName(t) };
}

/** Drop extensions down to something every beginner book covers. */
export function simplifyQuality(q: Quality): Quality {
  switch (q) {
    case '9': case '7sus4': return '7';
    case 'm9': return 'm7';
    case 'maj9': return 'maj7';
    case 'add9': case '6': case '5': return '';
    case 'm6': return 'm';
    case 'dim7': case 'm7b5': return 'dim';
    default: return q;
  }
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiName(midi: number): string {
  return SHARP_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}
