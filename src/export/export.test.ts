// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { writeMusicXml } from './musicxml';
import { writeMidi } from './midi';
import { buildScore } from './score';
import { parseMusicXml } from '../import/musicxml';
import { parseMidi } from '../import/midi';
import { SONG_DEFAULTS, type Song } from '../../shared/types';

const tab = (rows: string[]) => ['e', 'B', 'G', 'D', 'A', 'E'].map((l, i) => `${l}|${rows[i]}|`).join('\n');
const song = (over: Partial<Song>) => ({ ...SONG_DEFAULTS, id: 's', title: 'S', chordChart: '', tab: '', ...over }) as Song;

describe('MusicXML export', () => {
  it('round-trips through the importer: chords, rests, ties over the barline, both staves', () => {
    const xml = writeMusicXml({
      title: 'Round trip', bpm: 90, beatsPerBar: 4,
      parts: [{
        name: 'Piano', kind: 'piano',
        chords: [{ beat: 0, name: 'C' }, { beat: 4, name: 'F#m7' }],
        notes: [
          { beat: 0, duration: 1, midi: 72, staff: 1 }, { beat: 0, duration: 1, midi: 76, staff: 1 },
          { beat: 1.5, duration: 0.5, midi: 74, staff: 1 },
          { beat: 3, duration: 2, midi: 79, staff: 1 }, // crosses the barline: tied
          { beat: 0, duration: 8, midi: 48, staff: 2 },
          { beat: 2 + 2 / 3, duration: 1 / 3, midi: 60, staff: 2 }, // triplet eighth
        ],
      }],
    });
    expect(xml).toContain('<kind text="m7">minor-seventh</kind>');
    const back = parseMusicXml(xml);
    expect(back.bpm).toBe(90);
    expect(back.parts[0].staves).toBe(2);
    const r = (x: number) => Math.round(x * 12) / 12;
    const notes = back.parts[0].notes.map((x) => [r(x.beat), x.midi, r(x.duration), x.staff]);
    // Right hand comes back exactly; the tied G5 is one 2-beat note again.
    expect(notes.filter((x) => x[3] === 1)).toEqual([[0, 72, 1, 1], [0, 76, 1, 1], [1.5, 74, 0.5, 1], [3, 79, 2, 1]]);
    // Left hand is one voice per staff, so the long C3 is cut where the triplet note starts.
    expect(notes.filter((x) => x[3] === 2)).toEqual([[0, 48, r(2 + 2 / 3), 2], [r(2 + 2 / 3), 60, r(1 / 3), 2]]);
  });

  it('writes guitar notation with a tab staff (string + fret), at sounding pitch', () => {
    const s = song({ chordChart: '| C |', capo: 2, tab: tab(['0-------', '--1-----', '--------', '--------', '--------', '--------']) });
    const xml = writeMusicXml(buildScore(s, 'guitar', 'easy', 'triad'));
    expect(xml).toContain('<sign>TAB</sign>');
    expect(xml).toContain('<technical><string>1</string><fret>0</fret></technical>');
    expect(xml).toContain('<technical><string>2</string><fret>1</fret></technical>');
    expect(xml).toContain('Capo 2');
    const back = parseMusicXml(xml);
    // Open high E with capo 2 sounds F#4; B string fret 1 + capo 2 sounds D4.
    expect(back.parts[0].notes.filter((x) => x.staff === 1).map((x) => x.midi)).toEqual([66, 62]);
  });

  it('turns a guitar song into a piano grand staff', () => {
    const s = song({ chordChart: '| C | G |', tab: tab(['0-------|3-------', '--------|--------', '--------|--------', '--------|--------', '--------|--------', '--------|--------']) });
    const p = buildScore(s, 'piano', 'easy', 'triad').parts[0];
    expect(p.notes.filter((n) => n.staff === 1).map((n) => n.midi)).toEqual([64, 67]);
    expect(p.notes.filter((n) => n.staff === 2).map((n) => n.midi)).toEqual([48, 52, 55, 43, 47, 50]);
  });
});

describe('MIDI export', () => {
  it('round-trips through the importer', () => {
    const data = writeMidi({ title: 'T', bpm: 100, beatsPerBar: 3, tracks: [
      { name: 'Right hand', program: 0, notes: [{ beat: 0, duration: 1, midi: 72 }, { beat: 1, duration: 0.5, midi: 74 }] },
      { name: 'Left hand', program: 0, notes: [{ beat: 0, duration: 3, midi: 48 }] },
    ] });
    const back = parseMidi(data, 't.mid');
    expect(back.bpm).toBe(100);
    expect(back.beatsPerBar).toBe(3);
    expect(back.parts.map((p) => [p.name, p.notes.map((n) => [n.beat, n.duration, n.midi])])).toEqual([
      ['Right hand', [[0, 1, 72], [1, 0.5, 74]]],
      ['Left hand', [[0, 3, 48]]],
    ]);
  });
});
