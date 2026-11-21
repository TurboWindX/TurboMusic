/**
 * Sheet-music import: common shape for MIDI / MusicXML / Claude-transcribed scores,
 * and the conversion into a song with all three parts:
 *   piano  = the imported notes, split into right and left hand
 *   lead   = guitar tab of the right hand's top line
 *   chords = chord chart detected from the harmony
 */
import type { PianoPart, StoredPianoNote } from '../../shared/types';
import { detectChordChartFromPitches } from '../music/detectChords';
import { fingerLine } from '../music/refret';

export interface RawNote {
  /** Quarter-note beats from the start. */
  beat: number;
  duration: number;
  midi: number;
  /** 1 = upper staff (right hand), 2 = lower staff (left hand). */
  staff?: number;
  measure?: number;
}

export interface ImportedPart {
  id: string;
  name: string;
  detail?: string;
  notes: RawNote[];
  /** 2 = grand staff (piano): staff 1 right hand, staff 2 left hand. */
  staves: number;
  drums: boolean;
  /** Looks like a piano/keyboard part (pre-selected in the import dialog). */
  pianoLike: boolean;
}

export interface SheetImport {
  format: string;
  title?: string;
  composer?: string;
  bpm: number;
  beatsPerBar: number;
  parts: ImportedPart[];
  warnings: string[];
}

/** What a part becomes in the piano part. */
export type PartRole = 'auto' | 'right' | 'left' | 'off';

export const ROLE_LABEL: Record<PartRole, string> = {
  auto: 'auto (split hands)',
  right: 'right hand',
  left: 'left hand',
  off: "don't use",
};

const SPLIT = 60; // middle C: single-staff parts split here when set to auto
const GRID = 12; // onsets snap to 1/12 beat (16ths and triplets both land on it)

export function defaultRoles(sheet: SheetImport): Record<string, PartRole> {
  const roles: Record<string, PartRole> = {};
  const usable = sheet.parts.filter((p) => !p.drums);
  const piano = usable.filter((p) => p.pianoLike);
  const chosen = piano.length ? piano : usable;
  for (const p of sheet.parts) roles[p.id] = chosen.includes(p) ? 'auto' : 'off';
  // Two single-staff parts (typical "RH" + "LH" MIDI tracks): higher one is the right hand.
  if (chosen.length === 2 && chosen.every((p) => p.staves < 2)) {
    const [a, b] = chosen.map((p) => avgPitch(p.notes));
    roles[chosen[0].id] = a >= b ? 'right' : 'left';
    roles[chosen[1].id] = a >= b ? 'left' : 'right';
  }
  return roles;
}

function avgPitch(ns: RawNote[]) {
  return ns.reduce((s, n) => s + n.midi, 0) / Math.max(1, ns.length);
}

const snap = (b: number) => Math.round(b * GRID) / GRID;

export function toPianoNotes(sheet: SheetImport, roles: Record<string, PartRole>): StoredPianoNote[] {
  const byKey = new Map<string, StoredPianoNote>();
  for (const p of sheet.parts) {
    const role = roles[p.id] ?? 'off';
    if (role === 'off') continue;
    for (const n of p.notes) {
      const hand: 'right' | 'left' =
        role === 'right' || role === 'left' ? role
          : p.staves >= 2 && n.staff !== undefined ? (n.staff >= 2 ? 'left' : 'right')
            : n.midi >= SPLIT ? 'right' : 'left';
      const beat = snap(n.beat);
      const note = { beat, duration: Math.max(1 / GRID, snap(n.beat + n.duration) - beat), midi: n.midi, hand };
      // Same key struck twice at once (doubled parts): keep one, the longer.
      const key = `${beat}:${n.midi}`;
      const prev = byKey.get(key);
      if (!prev || prev.duration < note.duration) byKey.set(key, note);
    }
  }
  const notes = [...byKey.values()].sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  if (!notes.length) return notes;
  // Drop leading silence in whole bars so bar 1 is where the music starts.
  const shift = Math.floor(notes[0].beat / sheet.beatsPerBar) * sheet.beatsPerBar;
  return shift > 0 ? notes.map((n) => ({ ...n, beat: n.beat - shift })) : notes;
}

export interface SongFromSheet {
  title: string;
  artist?: string;
  bpm: number;
  beatsPerBar: number;
  piano: PianoPart;
  /** Guitar lead (tab) and chord chart, derived from the piano part. */
  tab: string;
  chordChart: string;
  tabGrid: number;
  capo: number;
  melodyStartBar: number;
}

export function sheetToSong(sheet: SheetImport, roles: Record<string, PartRole>, source: string): SongFromSheet {
  const bpb = sheet.beatsPerBar;
  const notes = toPianoNotes(sheet, roles);
  if (!notes.length) throw new Error('No notes selected: pick at least one part');
  const end = Math.max(...notes.map((n) => n.beat + n.duration));
  const totalBars = Math.max(1, Math.ceil(end / bpb - 1e-6));
  return {
    title: sheet.title?.trim() || source.replace(/\.[^.]+$/, ''),
    artist: sheet.composer,
    bpm: Math.max(20, Math.min(300, Math.round(sheet.bpm))),
    beatsPerBar: bpb,
    piano: { source, notes },
    tab: melodyTab(notes, totalBars, bpb),
    chordChart: detectChordChartFromPitches(notes, totalBars, bpb),
    tabGrid: 2,
    capo: 0,
    melodyStartBar: 1,
  };
}

/**
 * Guitar tab of the right hand's top line, on an 8th-note grid
 * (3 characters per slot so two-digit frets never touch the next note).
 */
export function melodyTab(notes: StoredPianoNote[], totalBars: number, bpb: number): string {
  const slotsPerBar = bpb * 2;
  const right = notes.filter((n) => n.hand === 'right');
  const source = right.length ? right : notes;
  // Skyline: the highest note starting in each 8th slot.
  const top = new Map<number, number>();
  for (const n of source) {
    const slot = Math.round(n.beat * 2);
    if ((top.get(slot) ?? -1) < n.midi) top.set(slot, n.midi);
  }
  const slots = [...top.keys()].sort((a, b) => a - b);
  let pitches = slots.map((s) => top.get(s)!);
  // Guitar melodies sit around the open high e (E4); move by octaves to get there.
  const sorted = [...pitches].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] ?? 64;
  const octaves = Math.round((64 - median) / 12);
  pitches = pitches.map((p) => p + octaves * 12);
  const fingered = fingerLine(pitches);

  const cells = Array.from({ length: 6 }, () => Array.from({ length: totalBars * slotsPerBar }, () => '---'));
  slots.forEach((slot, i) => {
    if (slot >= totalBars * slotsPerBar) return;
    const { string, fret } = fingered[i];
    cells[5 - string][slot] = String(fret).padEnd(3, '-');
  });
  const labels = ['e', 'B', 'G', 'D', 'A', 'E'];
  const blocks: string[] = [];
  for (let b0 = 0; b0 < totalBars; b0 += 4) {
    const bars = Array.from({ length: Math.min(4, totalBars - b0) }, (_, k) => b0 + k);
    blocks.push(labels.map((l, row) => `${l}|${bars.map((bar) => cells[row].slice(bar * slotsPerBar, (bar + 1) * slotsPerBar).join('')).join('|')}|`).join('\n'));
  }
  return blocks.join('\n\n');
}
