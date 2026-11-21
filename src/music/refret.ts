/**
 * Transpose a tab melody by N semitones and re-finger it so every note is
 * playable in standard tuning (used for "no capo" mode, where the whole song
 * moves down instead of the chord player using a capo).
 */
import type { TabNote } from './tabParser';
import { STANDARD_TUNING } from './theory';

const LOWEST = STANDARD_TUNING[0]; // low E
const MAX_FRET = 15;

export function transposeMelody(notes: TabNote[], semitones: number): TabNote[] {
  if (!semitones) return notes;
  // If anything would fall below low E, move the whole line up an octave so the
  // melody keeps its shape instead of single notes jumping around.
  const lowest = Math.min(...notes.map(pitch)) + semitones;
  if (notes.length && lowest < LOWEST) semitones += 12 * Math.ceil((LOWEST - lowest) / 12);
  const out: TabNote[] = [];
  let prev: { string: number; fret: number } | null = null;
  let i = 0;
  while (i < notes.length) {
    // Notes starting together must land on different strings.
    let j = i;
    while (j < notes.length && notes[j].beat === notes[i].beat) j++;
    const group = notes.slice(i, j).sort((a, b) => pitch(a) - pitch(b));
    const used = new Set<number>();
    for (const n of group) {
      let midi = pitch(n) + semitones;
      while (midi < LOWEST) midi += 12; // below the guitar's range: up an octave
      const placed = place(midi, n, prev, used);
      used.add(placed.string);
      out.push({ ...n, string: placed.string, fret: placed.fret });
      prev = placed;
    }
    i = j;
  }
  return out.sort((a, b) => a.beat - b.beat || a.string - b.string);
}

function pitch(n: TabNote) {
  return STANDARD_TUNING[n.string] + n.fret;
}

function place(midi: number, orig: TabNote, prev: { string: number; fret: number } | null, used: Set<number>) {
  let best: { string: number; fret: number; cost: number } | null = null;
  for (let s = 0; s < 6; s++) {
    if (used.has(s)) continue;
    const fret = midi - STANDARD_TUNING[s];
    if (fret < 0 || fret > MAX_FRET) continue;
    let cost = fret * 0.45 + (fret > 5 ? (fret - 5) * 0.6 : 0); // strongly prefer open/low positions for a learner
    if (s === orig.string) cost -= 0.3; // mild preference for the original string
    if (prev) cost += Math.abs(fret - prev.fret) * 0.25 + Math.abs(s - prev.string) * 0.2;
    if (!best || cost < best.cost) best = { string: s, fret, cost };
  }
  if (best) return best;
  // Everything taken or out of range: fall back to the highest string, clamped.
  const s = 5;
  return { string: s, fret: Math.max(0, Math.min(24, midi - STANDARD_TUNING[s])) };
}
