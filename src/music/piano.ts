/** Piano basics: note type, left-hand chord voicings, keyboard layout helpers. */
import { parseChord, simplifyQuality, SHARP_NAMES, type Quality } from './theory';

export type Hand = 'right' | 'left';
export type LeftStyle = 'root' | 'triad' | 'full';

export interface PianoNote {
  beat: number;
  duration: number;
  midi: number;
  hand: Hand;
  /** Chord name for left-hand notes (shown on the falling block). */
  chord?: string;
}

const INTERVALS: Record<Quality, number[]> = {
  '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11],
  sus2: [0, 2, 7], sus4: [0, 5, 7], '7sus4': [0, 5, 7, 10], add9: [0, 2, 4, 7],
  dim: [0, 3, 6], dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10], aug: [0, 4, 8],
  '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], '9': [0, 4, 7, 10], m9: [0, 3, 7, 10], maj9: [0, 4, 7, 11], '5': [0, 7],
};

export const MIDDLE_C = 60;

/** Left-hand notes for a chord name, transposed by `shift` semitones. Bass sits around C3. */
export function leftHandVoicing(chord: string, shift: number, style: LeftStyle): number[] {
  const p = parseChord(chord);
  if (!p) return [];
  const root = (((p.root + shift) % 12) + 12) % 12;
  // Root between F2 and E3 keeps the left hand in one comfortable spot.
  let base = 48 + root;
  if (base > 52) base -= 12;
  if (style === 'root') return [base];
  const q = style === 'triad' ? simplifyQuality(p.quality) : p.quality;
  const iv = INTERVALS[q] ?? INTERVALS[''];
  return (style === 'triad' ? iv.slice(0, 3) : iv).map((i) => base + i);
}

export function noteName(midi: number): string {
  return SHARP_NAMES[((midi % 12) + 12) % 12];
}

export function isBlack(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

/** Keyboard range covering the notes, snapped to whole octaves (C..B), at least two octaves. */
export function keyboardRange(notes: PianoNote[]): { lo: number; hi: number } {
  if (!notes.length) return { lo: 48, hi: 83 };
  let lo = Math.min(...notes.map((n) => n.midi));
  let hi = Math.max(...notes.map((n) => n.midi));
  lo = Math.floor(lo / 12) * 12;
  hi = Math.ceil((hi + 1) / 12) * 12 - 1;
  while (hi - lo < 23) { if (lo > 36) lo -= 12; else hi += 12; }
  return { lo, hi };
}
