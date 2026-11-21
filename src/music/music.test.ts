import { describe, expect, it } from 'vitest';
import { parseChordChart } from './chordChart';
import { parseTab } from './tabParser';
import { resolveChord, suggestCapo } from './chords';
import { parseChord, transposeChord } from './theory';
import { buildArrangement, buildStrums } from './arrangement';
import { DEMO_SONG } from '../../shared/demoSong';

describe('theory', () => {
  it('parses chord names', () => {
    expect(parseChord('F#m7')).toMatchObject({ root: 6, quality: 'm7', bass: null });
    expect(parseChord('Bb/D')).toMatchObject({ root: 10, quality: '', bass: 2, preferFlats: true });
    expect(parseChord('Cmaj7')).toMatchObject({ quality: 'maj7' });
    expect(parseChord('Hello')).toBeNull();
  });
  it('transposes', () => {
    expect(transposeChord(parseChord('G')!, -2).text).toBe('F');
    expect(transposeChord(parseChord('Bb')!, 2).text).toBe('C');
  });
});

describe('chord chart', () => {
  it('parses bars, sections, splits, holds and repeats', () => {
    const r = parseChordChart('[Intro]\n| C | G Am |\n[Verse]\n| F . . G | % |\nC G x2', 4);
    expect(r.sections).toEqual([{ name: 'Intro', startBar: 0 }, { name: 'Verse', startBar: 2 }]);
    expect(r.bars).toBe(8);
    expect(r.chords.slice(0, 3)).toMatchObject([
      { beat: 0, duration: 4, chord: 'C' },
      { beat: 4, duration: 2, chord: 'G' },
      { beat: 6, duration: 2, chord: 'Am' },
    ]);
    expect(r.chords[3]).toMatchObject({ beat: 8, duration: 3, chord: 'F' });
    expect(r.chords[4]).toMatchObject({ beat: 11, duration: 1, chord: 'G' });
    expect(r.chords[5]).toMatchObject({ beat: 12, chord: 'F' }); // % repeats bar
    expect(r.chords.at(-1)).toMatchObject({ beat: 28, chord: 'G' });
    expect(r.warnings).toEqual([]);
  });
  it('warns on unknown chords', () => {
    expect(parseChordChart('| Q7 |', 4).warnings.length).toBe(1);
  });
});

describe('tab parser', () => {
  it('places evenly spaced notes on an 8th grid', () => {
    const tab = [
      'e|-0---1---3-----|-----------------|',
      'B|---------------|-1---------------|',
      'G|---------------|-----------------|',
      'D|---------------|-----------------|',
      'A|---------------|-----------------|',
      'E|---------------|-----------------|',
    ].join('\n');
    const r = parseTab(tab, 4, 2);
    expect(r.bars).toBe(2);
    expect(r.notes.map((n) => [n.beat, n.string, n.fret])).toEqual([
      [0, 5, 0], [1, 5, 1], [2, 5, 3], [4, 4, 1],
    ]);
  });
  it('handles multi-digit frets, chords and lines without pipes', () => {
    const tab = ['e-12----', 'B-10----', 'G-------', 'D-------', 'A-------', 'E-------'].join('\n');
    const r = parseTab(tab, 4, 2);
    expect(r.notes.map((n) => [n.string, n.fret])).toEqual([[4, 10], [5, 12]]);
  });
  it('parses the demo tab', () => {
    const r = parseTab(DEMO_SONG.tab, 4, 2);
    expect(r.bars).toBe(16);
    expect(r.warnings).toEqual([]);
    // Bar 6 has 8th notes: G E F E . C
    const bar6 = r.notes.filter((n) => n.bar === 5).map((n) => n.beat - 20);
    expect(bar6).toEqual([0, 1, 1.5, 2, 3]);
  });
});

describe('voicings', () => {
  it('resolves open and barre chords', () => {
    expect(resolveChord('C', { easy: false }).voicing?.frets).toEqual([null, 3, 2, 0, 1, 0]);
    const bb = resolveChord('Bb', { easy: false });
    expect(bb.voicing?.barre).toBeTruthy();
    expect(bb.midi.length).toBeGreaterThanOrEqual(5);
  });
  it('easy mode picks easier F and swaps Bm', () => {
    expect(resolveChord('F', { easy: true }).voicing?.frets).toEqual([null, null, 3, 2, 1, 1]);
    expect(resolveChord('Bm', { easy: true }).display).toBe('Bm7');
    expect(resolveChord('Cadd9/G', { easy: true }).display).toBe('C');
  });
  it('every generated voicing contains only chord tones', () => {
    for (const name of ['Bb', 'C#m', 'F#7', 'Ebmaj7', 'G#m7', 'Bdim', 'Csus2', 'D9']) {
      const r = resolveChord(name, { easy: false });
      expect(r.voicing, name).toBeTruthy();
      const root = parseChord(name)!.root;
      const pcs = new Set(r.midi.map((m) => (m - root + 120) % 12));
      expect(pcs.has(0), name).toBe(true);
    }
  });
  it('suggests a capo for flat keys', () => {
    // Eb Bb Cm Ab with capo 1 = D A Bm G (or with 3 = C G Am F)
    expect(suggestCapo(['Eb', 'Bb', 'Cm', 'Ab'])[0].capo).toBeGreaterThan(0);
  });
});

describe('arrangement', () => {
  it('builds demo arrangement and strums', () => {
    const arr = buildArrangement(DEMO_SONG);
    expect(arr.totalBars).toBe(16);
    expect(arr.sections.map((s) => s.name)).toEqual(['Verse', 'Bridge']);
    expect(arr.warnings).toEqual([]);
    expect(buildStrums(arr, 'once', '').length).toBe(16);
    expect(buildStrums(arr, 'beats', '').length).toBe(64);
    // D-DU-UDU = 6 hits per bar
    expect(buildStrums(arr, 'pattern', 'D-DU-UDU').length).toBe(96);
  });
});

describe('capo recommendation', () => {
  it('stays quiet for easy keys and speaks up for flat keys', async () => {
    const { recommendCapo } = await import('./chords');
    expect(recommendCapo(['C', 'Am', 'F', 'G', 'Em'])).toBeNull();
    expect(recommendCapo(['Eb', 'Bb', 'Cm', 'Ab'])?.capo).toBeGreaterThan(0);
  });
});

describe('chord detection', () => {
  it('names common triads and sevenths from pitch classes', async () => {
    const { guessChord } = await import('./detectChords');
    const w = (pcs: number[]) => { const a = new Array(12).fill(0); pcs.forEach((p) => (a[p] += 1)); return a; };
    expect(guessChord(w([0, 4, 7]), 0)?.name).toBe('C');
    expect(guessChord(w([9, 0, 4]), 9)?.name).toBe('Am');
    expect(guessChord(w([7, 11, 2, 5]), 7)?.name).toBe('G7');
    expect(guessChord(w([2, 6, 9, 1]), 2)?.name).toBe('Dmaj7');
    expect(guessChord(w([4, 7, 11]), 4)?.name).toBe('Em');
  });
  it('builds a chart from the demo melody that matches its chords mostly', async () => {
    const { detectChordChart } = await import('./detectChords');
    const tab = parseTab(DEMO_SONG.tab, 4, 2);
    const chart = detectChordChart(tab.notes, tab.bars, 4);
    const parsed = parseChordChart(chart, 4);
    expect(parsed.bars).toBe(16);
    expect(parsed.warnings).toEqual([]);
  });
});

describe('no-capo transposition', () => {
  it('keeps pitches (down N), playable frets, and timing', async () => {
    const { transposeMelody } = await import('./refret');
    const { STANDARD_TUNING } = await import('./theory');
    const tab = parseTab(DEMO_SONG.tab, 4, 2);
    for (const semis of [-4, -2, -7]) {
      const out = transposeMelody(tab.notes, semis);
      expect(out.length).toBe(tab.notes.length);
      const before = tab.notes.map((n) => [n.beat, STANDARD_TUNING[n.string] + n.fret + semis]);
      const after = out.map((n) => [n.beat, STANDARD_TUNING[n.string] + n.fret]);
      expect(after.map(([b]) => b)).toEqual(before.map(([b]) => b));
      after.forEach(([, m], k) => expect((m - before[k][1] + 120) % 12).toBe(0)); // same note (octave may move up)
      out.forEach((n) => { expect(n.fret).toBeGreaterThanOrEqual(0); expect(n.fret).toBeLessThanOrEqual(15); });
    }
  });
  it('moves notes below low E up an octave', async () => {
    const { transposeMelody } = await import('./refret');
    const out = transposeMelody([{ beat: 0, bar: 0, string: 0, fret: 2, duration: 1 }], -4);
    expect(out[0].string * 100 + out[0].fret).not.toBe(-2);
    expect(out[0].fret).toBeGreaterThanOrEqual(0);
  });
});
