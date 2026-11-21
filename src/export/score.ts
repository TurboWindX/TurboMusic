/** A song as sheet music (piano grand staff, or guitar notation + tab) and as a MIDI file. */
import type { Song } from '../../shared/types';
import { buildArrangement } from '../music/arrangement';
import { pianoLead, pianoRhythm, songPartContext } from '../music/parts';
import { chordName, parseChord, STANDARD_TUNING, transposeChord } from '../music/theory';
import type { Level } from '../state/settings';
import { writeMidi } from './midi';
import { writeMusicXml, type SheetScore } from './musicxml';

export type SheetLayout = 'piano' | 'guitar';

const sounding = (name: string, shift: number) => {
  const p = parseChord(name);
  return p && shift ? chordName(transposeChord(p, shift)) : name;
};

export function buildScore(song: Song, layout: SheetLayout, level: Level, easyChords: 'root' | 'triad'): SheetScore {
  const ctx = songPartContext(song, buildArrangement);
  const base = { title: song.title, composer: song.artist, bpm: song.bpm, beatsPerBar: song.beatsPerBar };
  if (layout === 'piano') {
    const right = pianoLead(ctx, level, false, easyChords);
    const left = pianoRhythm(ctx, level, easyChords);
    return {
      ...base,
      parts: [{
        name: 'Piano',
        kind: 'piano',
        notes: [...right.map((n) => ({ ...n, staff: 1 as const })), ...left.map((n) => ({ ...n, staff: 2 as const }))],
        // Piano reads concert pitch: chord names as they sound.
        chords: ctx.arrEasy.chords.map((c) => ({ beat: c.beat, name: sounding(c.chord, song.capo) })),
      }],
    };
  }
  const arr = level === 'original' ? ctx.arrOriginal : ctx.arrEasy;
  const notes = arr.melody.flatMap((n) => {
    const midi = STANDARD_TUNING[n.string] + n.fret + song.capo;
    const d = Math.max(0.25, Math.min(n.duration, 4));
    return [
      { beat: n.beat, duration: d, midi, staff: 1 as const },
      { beat: n.beat, duration: d, midi, staff: 2 as const, string: n.string, fret: n.fret },
    ];
  });
  return {
    ...base,
    // Guitarists read shapes: chord names as written (relative to the capo).
    parts: [{ name: 'Guitar', kind: 'guitar', notes, capo: song.capo || undefined, chords: ctx.arrEasy.chords.map((c) => ({ beat: c.beat, name: c.chord })) }],
  };
}

export function scoreToMusicXml(score: SheetScore): string {
  return writeMusicXml(score);
}

export function scoreToMidi(score: SheetScore): Uint8Array {
  const part = score.parts[0];
  const program = part.kind === 'piano' ? 0 : 25;
  const staff = (s: 1 | 2) => part.notes.filter((n) => n.staff === s);
  return writeMidi({
    title: score.title,
    bpm: score.bpm,
    beatsPerBar: score.beatsPerBar,
    tracks: part.kind === 'piano'
      ? [{ name: 'Right hand', program, notes: staff(1) }, { name: 'Left hand', program, notes: staff(2) }]
      : [{ name: 'Guitar', program, notes: staff(1) }],
  });
}
