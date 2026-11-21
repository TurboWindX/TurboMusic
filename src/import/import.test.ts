// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseMidi } from './midi';
import { parseMusicXml, playOrder } from './musicxml';
import { defaultRoles, sheetToSong, toPianoNotes, type SheetImport } from './sheet';
import { parseTab } from '../music/tabParser';
import { parseChordChart } from '../music/chordChart';
import { STANDARD_TUNING } from '../music/theory';
import { flatten, pitchToMidi } from '../../server/transcriber';

// ---------------------------------------------------------------- MIDI

const vlq = (n: number) => {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};
const str = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const track = (events: number[]) => [...str('MTrk'), ...u32(events.length + 4), ...events, 0, 0xff, 0x2f, 0];

function smf(tracks: number[][], ppq = 480) {
  return new Uint8Array([...str('MThd'), ...u32(6), 0, 1, 0, tracks.length, (ppq >> 8) & 255, ppq & 255, ...tracks.flat()]);
}

describe('MIDI import', () => {
  const q = 480;
  const file = smf([
    track([0, 0xff, 0x03, 4, ...str('Song'), 0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0xff, 0x58, 4, 3, 2, 24, 8]),
    // right hand: C5 quarter, E5 quarter (running status, note-on velocity 0 as note-off)
    track([0, 0xff, 0x03, 8, ...str('Piano RH'), 0, 0x90, 72, 90, ...vlq(q), 72, 0, 0, 76, 90, ...vlq(q), 76, 0]),
    // left hand: C3 half note, real note-off
    track([0, 0xff, 0x03, 8, ...str('Piano LH'), 0, 0x91, 48, 70, ...vlq(2 * q), 0x81, 48, 0]),
  ]);

  it('reads tempo, time signature, tracks and notes', () => {
    const s = parseMidi(file, 'x.mid');
    expect(s.title).toBe('Song');
    expect(s.bpm).toBe(120);
    expect(s.beatsPerBar).toBe(3);
    expect(s.parts.map((p) => p.name)).toEqual(['Piano RH', 'Piano LH']);
    expect(s.parts[0].notes).toEqual([{ beat: 0, duration: 1, midi: 72 }, { beat: 1, duration: 1, midi: 76 }]);
    expect(s.parts[1].notes).toEqual([{ beat: 0, duration: 2, midi: 48 }]);
  });

  it('assigns the higher track to the right hand', () => {
    const s = parseMidi(file, 'x.mid');
    expect(defaultRoles(s)).toEqual({ [s.parts[0].id]: 'right', [s.parts[1].id]: 'left' });
  });

  it('rejects things that are not MIDI', () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]))).toThrow(/Not a MIDI/);
  });
});

// ---------------------------------------------------------------- MusicXML

const note = (step: string, oct: number, dur: number, opts: { staff?: number; chord?: boolean; tie?: string; alter?: number } = {}) => `
  <note>${opts.chord ? '<chord/>' : ''}<pitch><step>${step}</step>${opts.alter ? `<alter>${opts.alter}</alter>` : ''}<octave>${oct}</octave></pitch>
  <duration>${dur}</duration>${opts.tie ? `<tie type="${opts.tie}"/>` : ''}<staff>${opts.staff ?? 1}</staff></note>`;

const xml = `<?xml version="1.0"?>
<score-partwise version="4.0">
  <work><work-title>Little Piece</work-title></work>
  <identification><creator type="composer">Someone</creator></identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>
      <direction><sound tempo="72"/></direction>
      ${note('C', 5, 2)}${note('E', 5, 2, { chord: true })}${note('G', 4, 2)}${note('F', 4, 4, { tie: 'start', alter: 1 })}
      <backup><duration>8</duration></backup>
      ${note('C', 3, 8, { staff: 2 })}
    </measure>
    <measure number="2">
      ${note('F', 4, 2, { tie: 'stop', alter: 1 })}${note('A', 4, 6)}
      <backup><duration>8</duration></backup>
      ${note('F', 2, 8, { staff: 2 })}
      <barline location="right"><repeat direction="backward"/></barline>
    </measure>
  </part>
</score-partwise>`;

describe('MusicXML import', () => {
  it('reads chords, ties, two staves and expands the repeat', () => {
    const s = parseMusicXml(xml);
    expect(s.title).toBe('Little Piece');
    expect(s.composer).toBe('Someone');
    expect(s.bpm).toBe(72);
    expect(s.beatsPerBar).toBe(4);
    const p = s.parts[0];
    expect(p.staves).toBe(2);
    const first = p.notes.filter((n) => n.beat < 8).map((n) => [n.beat, n.midi, n.duration, n.staff]);
    expect(first).toEqual([
      [0, 48, 4, 2], [0, 72, 1, 1], [0, 76, 1, 1], // C3 whole (LH); C5+E5 chord
      [1, 67, 1, 1], // G4
      [2, 66, 3, 1], // F#4 half tied into a quarter = 3 beats, struck once
      [4, 41, 4, 2], [5, 69, 3, 1], // bar 2
    ]);
    // Repeat: bars 1-2 played twice -> 16 beats.
    expect(p.notes.filter((n) => n.beat >= 8).length).toBe(first.length);
    expect(Math.max(...p.notes.map((n) => n.beat))).toBe(13);
  });

  it('splits the grand staff into hands', () => {
    const s = parseMusicXml(xml);
    const notes = toPianoNotes(s, defaultRoles(s));
    expect(notes.filter((n) => n.hand === 'left').map((n) => n.midi)).toEqual([48, 41, 48, 41]);
  });

  it('plays 1st and 2nd endings in order', () => {
    const m = (o: Partial<{ forward: boolean; backward: number; endingStart: number[] | null; endingStop: boolean }> = {}) =>
      ({ forward: false, backward: 0, endingStart: null, endingStop: false, jump: false, ...o });
    expect(playOrder([m({ forward: true }), m({ endingStart: [1], endingStop: true, backward: 2 }), m({ endingStart: [2], endingStop: true }), m()]))
      .toEqual([0, 1, 0, 2, 3]);
  });
});

// ---------------------------------------------------------------- sheet -> song

describe('sheet to song', () => {
  const sheet: SheetImport = {
    format: 'test', title: 'T', bpm: 100, beatsPerBar: 4, warnings: [],
    parts: [{
      id: 'p', name: 'Piano', staves: 2, drums: false, pianoLike: true,
      notes: [
        // a bar of rest first (trimmed), then melody C5 D5 E5 (+ a lower inner voice) over a C chord
        { beat: 4, duration: 1, midi: 72, staff: 1 }, { beat: 4, duration: 1, midi: 64, staff: 1 },
        { beat: 5, duration: 1, midi: 74, staff: 1 }, { beat: 6, duration: 2, midi: 76, staff: 1 },
        { beat: 4, duration: 4, midi: 48, staff: 2 }, { beat: 4, duration: 4, midi: 55, staff: 2 },
      ],
    }],
  };

  it('makes a piano part, a playable guitar melody and a chord chart', () => {
    const song = sheetToSong(sheet, defaultRoles(sheet), 'x.mid');
    expect(song.piano.notes[0].beat).toBe(0); // leading empty bar removed
    expect(song.piano.notes.filter((n) => n.hand === 'right')).toHaveLength(4);

    const tab = parseTab(song.tab, 4, 2);
    expect(tab.warnings).toEqual([]);
    // Top line only (C D E), an octave down so it sits in the guitar's middle register.
    expect(tab.notes.map((n) => STANDARD_TUNING[n.string] + n.fret)).toEqual([60, 62, 64]);
    expect(tab.notes.map((n) => n.beat)).toEqual([0, 1, 2]);

    const chart = parseChordChart(song.chordChart, 4);
    expect(chart.chords.map((c) => c.chord)).toEqual(['C']);
  });
});

// ---------------------------------------------------------------- Claude transcription result

describe('scan transcription result', () => {
  it('parses scientific pitch names', () => {
    expect(pitchToMidi('C4')).toBe(60);
    expect(pitchToMidi('F#3')).toBe(54);
    expect(pitchToMidi('Bb2')).toBe(46);
    expect(pitchToMidi('nonsense')).toBeNull();
  });

  it('lays measures end to end, pickup included', () => {
    const t = flatten({
      title: 'x', composer: '', bpm: 80, beatsPerBar: 3, remarks: '',
      measures: [
        { number: 0, beats: 1, right: [{ beat: 0, duration: 1, pitches: ['G4'] }], left: [] },
        { number: 1, beats: 3, right: [{ beat: 0, duration: 3, pitches: ['C5', 'E5'] }], left: [{ beat: 0, duration: 3, pitches: ['C3'] }] },
      ],
    });
    expect(t.notes.map((n) => [n.beat, n.midi, n.staff])).toEqual([[0, 67, 1], [1, 48, 2], [1, 72, 1], [1, 76, 1]]);
  });
});
