/**
 * The two parts of a song (rhythm = harmony, lead = melody) for any instrument and level.
 *
 *              guitar                              piano
 * rhythm easy  easy shapes (+ auto capo)           simple chords (root or triad) per bar
 *        orig  chords as written                   imported left hand, else full chords
 * lead   easy  song.tab (simplified melody)        top line only (one note at a time)
 *        orig  song.originalTab (full tab)         imported right hand / full tab, all notes
 *
 * Piano notes are sounding pitches so mixed guitar/piano duets are in the same key.
 */
import type { Song } from '../../shared/types';
import type { Arrangement } from './arrangement';
import { leftHandVoicing, type PianoNote } from './piano';
import { chordName, parseChord, STANDARD_TUNING, transposeChord } from './theory';
import type { Level } from '../state/settings';

export interface PartContext {
  song: Song;
  /** Arrangement of song.tab, and of song.originalTab (or song.tab when there is none). */
  arrEasy: Arrangement;
  arrOriginal: Arrangement;
  /** Tab pitches -> sounding. */
  melodyShift: number;
  /** Chord-chart names -> sounding. */
  chordShift: number;
  /** Imported piano notes -> sounding (only moves in "no capo" mode). */
  importShift: number;
}

const GRID = 12;

/** Highest note at each onset: turns chords/fingerstyle into a single melody line. */
export function skyline(notes: PianoNote[]): PianoNote[] {
  const top = new Map<number, PianoNote>();
  for (const n of notes) {
    const k = Math.round(n.beat * GRID);
    const cur = top.get(k);
    if (!cur || n.midi > cur.midi) top.set(k, n);
  }
  const line = [...top.values()].sort((a, b) => a.beat - b.beat);
  // Each note lasts until the next one at most, so the line reads cleanly.
  return line.map((n, i) => ({ ...n, duration: Math.min(n.duration, (line[i + 1]?.beat ?? Infinity) - n.beat) || n.duration }));
}

function tabToPiano(arr: Arrangement, shift: number): PianoNote[] {
  const pitches = arr.melody.map((n) => STANDARD_TUNING[n.string] + n.fret + shift);
  const sorted = [...pitches].sort((a, b) => a - b);
  const median = sorted.length ? sorted[sorted.length >> 1] : 60;
  // Guitar sounds an octave below where piano music sits; lift low lines into the treble.
  const octave = median < 57 ? 12 : 0;
  return arr.melody
    .map((n, i) => ({ beat: n.beat, duration: Math.max(0.25, Math.min(n.duration, 4)), midi: pitches[i] + octave, hand: 'right' as const }))
    .sort((a, b) => a.beat - b.beat || a.midi - b.midi);
}

/** Lead on piano: the melody in the right hand, optionally with the left hand too. */
export function pianoLead(ctx: PartContext, level: Level, bothHands: boolean, easyChords: 'root' | 'triad'): PianoNote[] {
  const imported = ctx.song.piano?.notes.filter((n) => n.hand === 'right') ?? [];
  let right: PianoNote[];
  if (imported.length) {
    const all = imported.map((n) => ({ beat: n.beat, duration: n.duration, midi: n.midi + ctx.importShift, hand: 'right' as const }));
    right = level === 'easy' ? skyline(all) : all;
  } else {
    const all = tabToPiano(level === 'easy' ? ctx.arrEasy : ctx.arrOriginal, ctx.melodyShift);
    right = level === 'easy' ? skyline(all) : all;
  }
  const left = bothHands ? pianoRhythm(ctx, level, easyChords) : [];
  return [...right, ...left].sort((a, b) => a.beat - b.beat || a.midi - b.midi);
}

/** Rhythm on piano: the harmony in the left hand. */
export function pianoRhythm(ctx: PartContext, level: Level, easyChords: 'root' | 'triad'): PianoNote[] {
  const arr = ctx.arrEasy;
  const imported = ctx.song.piano?.notes.filter((n) => n.hand === 'left') ?? [];
  if (level === 'original' && imported.length) {
    return labelChords(imported.map((n) => ({ beat: n.beat, duration: n.duration, midi: n.midi + ctx.importShift, hand: 'left' as const })), arr, ctx.importShift);
  }
  const out: PianoNote[] = [];
  const bpb = arr.beatsPerBar;
  for (const c of arr.chords) {
    const notes = leftHandVoicing(c.chord, ctx.chordShift, level === 'easy' ? easyChords : 'full');
    if (!notes.length) continue;
    const parsed = parseChord(c.chord);
    const label = parsed && ctx.chordShift ? chordName(transposeChord(parsed, ctx.chordShift)) : c.chord;
    const end = c.beat + c.duration;
    // Re-struck every bar so long chords keep a pulse to follow.
    for (let b = c.beat; b < end - 1e-6; ) {
      const d = Math.min(end, (Math.floor(b / bpb + 1e-6) + 1) * bpb) - b;
      for (const m of notes) out.push({ beat: b, duration: d, midi: m, hand: 'left', chord: label });
      b += d;
    }
  }
  return out.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
}

/** Name the chord (from the chord chart) on imported left-hand notes. */
function labelChords(notes: PianoNote[], arr: Arrangement, shift: number): PianoNote[] {
  let ci = 0;
  return notes.sort((a, b) => a.beat - b.beat || a.midi - b.midi).map((n) => {
    while (ci + 1 < arr.chords.length && arr.chords[ci + 1].beat <= n.beat + 1e-6) ci++;
    const c = arr.chords[ci];
    const p = c && c.beat <= n.beat + 1e-6 ? parseChord(c.chord) : null;
    return { ...n, chord: p ? (shift ? chordName(transposeChord(p, shift)) : c.chord) : undefined };
  });
}

/** Does "original" give something different from "easy" for this part? (to explain it in the UI) */
export function originalDiffers(song: Song, role: 'rhythm' | 'lead', instrument: 'guitar' | 'piano'): boolean {
  if (role === 'rhythm') return true;
  if (instrument === 'guitar') return !!song.originalTab?.trim();
  return true;
}

/** Part context at the song's own key (no capo adjustments): for sheet music and exports. */
export function songPartContext(song: Song, build: (s: Song) => Arrangement): PartContext {
  const arrEasy = build(song);
  const arrOriginal = song.originalTab?.trim() ? build({ ...song, tab: song.originalTab }) : arrEasy;
  return { song, arrEasy, arrOriginal, melodyShift: song.capo, chordShift: song.capo, importShift: 0 };
}
