/** Builds the playable arrangement (timed events for both parts) from a Song. */
import type { Song } from '../../shared/types';
import { parseChordChart, type ChordEvent, type Section } from './chordChart';
import { parseTab, type TabNote } from './tabParser';

export type StrumMode = 'once' | 'beats' | 'pattern';

export interface StrumEvent {
  beat: number;
  chord: string;
  dir: 'D' | 'U';
}

export interface Arrangement {
  beatsPerBar: number;
  totalBars: number;
  totalBeats: number;
  chords: ChordEvent[];
  melody: TabNote[];
  sections: Section[];
  warnings: string[];
  /** Unique chord names, in order of first appearance. */
  uniqueChords: string[];
}

export function buildArrangement(song: Song): Arrangement {
  const bpb = Math.max(1, song.beatsPerBar);
  const chart = parseChordChart(song.chordChart, bpb);
  const tab = parseTab(song.tab, bpb, Math.max(1, song.tabGrid));
  const offsetBars = Math.max(0, (song.melodyStartBar || 1) - 1);
  const melody = tab.notes.map((n) => ({ ...n, beat: n.beat + offsetBars * bpb, bar: n.bar + offsetBars }));
  const totalBars = Math.max(1, chart.bars, tab.bars ? tab.bars + offsetBars : 0);

  const warnings = [...chart.warnings, ...tab.warnings];
  if (chart.bars && tab.bars && chart.bars !== tab.bars + offsetBars) {
    warnings.push(`Chord chart has ${chart.bars} bars, melody ends at bar ${tab.bars + offsetBars}`);
  }

  const uniqueChords = [...new Set(chart.chords.map((c) => c.chord))];
  return {
    beatsPerBar: bpb,
    totalBars,
    totalBeats: totalBars * bpb,
    chords: chart.chords,
    melody,
    sections: chart.sections,
    warnings,
    uniqueChords,
  };
}

/** Strum hits for the chord part. Pattern slots are 8th notes. */
export function buildStrums(arr: Arrangement, mode: StrumMode, pattern: string): StrumEvent[] {
  const out: StrumEvent[] = [];
  if (mode === 'once') {
    for (const c of arr.chords) out.push({ beat: c.beat, chord: c.chord, dir: 'D' });
    return out;
  }
  const step = mode === 'beats' ? 1 : 0.5;
  const pat = (pattern || 'D-D-D-D-').toUpperCase().replace(/[^DU\-.X]/g, '');
  const slotsPerBar = Math.round(arr.beatsPerBar / step);
  let ci = 0;
  for (let bar = 0; bar < arr.totalBars; bar++) {
    for (let s = 0; s < slotsPerBar; s++) {
      const beat = bar * arr.beatsPerBar + s * step;
      while (ci + 1 < arr.chords.length && arr.chords[ci + 1].beat <= beat) ci++;
      const chord = arr.chords[ci];
      if (!chord || chord.beat > beat || beat >= chord.beat + chord.duration) continue;
      let dir: 'D' | 'U' | null;
      if (mode === 'beats') dir = 'D';
      else {
        const ch = pat[s % pat.length];
        dir = ch === 'D' ? 'D' : ch === 'U' ? 'U' : null;
        // Always hit a chord change on the downbeat even if the pattern rests there.
        if (!dir && Math.abs(chord.beat - beat) < 1e-6) dir = 'D';
      }
      if (dir) out.push({ beat, chord: chord.chord, dir });
    }
  }
  return out;
}

export function chordAt(arr: Arrangement, beat: number): { index: number; event: ChordEvent | null } {
  let lo = 0, hi = arr.chords.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr.chords[mid].beat <= beat + 1e-6) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const ev = idx >= 0 ? arr.chords[idx] : null;
  if (ev && beat >= ev.beat + ev.duration) return { index: idx, event: null };
  return { index: idx, event: ev };
}

export function sectionAt(arr: Arrangement, bar: number): Section | null {
  let s: Section | null = null;
  for (const sec of arr.sections) if (sec.startBar <= bar) s = sec;
  return s;
}
