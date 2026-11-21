import { describe, expect, it } from 'vitest';
import { buildArrangement } from './arrangement';
import { keyboardRange, leftHandVoicing, type PianoNote } from './piano';
import { pianoLead, pianoRhythm, songPartContext, type PartContext } from './parts';
import { HIT, MISS, PracticeTracker } from './practice';
import { SONG_DEFAULTS, type Song } from '../../shared/types';

const song = (over: Partial<Song>): Song => ({ ...SONG_DEFAULTS, id: 't', title: 't', ...over } as Song);

describe('piano part', () => {
  it('voices left-hand chords around C3', () => {
    expect(leftHandVoicing('C', 0, 'triad')).toEqual([48, 52, 55]);
    expect(leftHandVoicing('Am', 0, 'triad')).toEqual([45, 48, 52]);
    expect(leftHandVoicing('G7', 0, 'triad')).toEqual([43, 47, 50]); // simplified to G
    expect(leftHandVoicing('G7', 0, 'full')).toEqual([43, 47, 50, 53]);
    expect(leftHandVoicing('Am', 0, 'root')).toEqual([45]);
    expect(leftHandVoicing('C', 2, 'root')).toEqual([50]); // capo 2 -> sounds D
  });

  const ctxFor = (over: Partial<Song>, shift = { melody: 0, chord: 0 }): PartContext => {
    const c = songPartContext(song(over), buildArrangement);
    return { ...c, melodyShift: shift.melody, chordShift: shift.chord };
  };
  const tab = (rows: string[]) => ['e', 'B', 'G', 'D', 'A', 'E'].map((l, i) => `${l}|${rows[i]}|`).join('\n');
  const empty = '--------';

  it('rhythm on piano: easy roots or triads re-struck each bar; original full chords', () => {
    const ctx = ctxFor({ beatsPerBar: 4, chordChart: '| C . . . | Am7 |', tab: '' });
    expect(pianoRhythm(ctx, 'easy', 'root').map((n) => [n.beat, n.midi, n.chord])).toEqual([[0, 48, 'C'], [4, 45, 'Am7']]);
    expect(pianoRhythm(ctx, 'easy', 'triad').filter((n) => n.beat === 4).map((n) => n.midi)).toEqual([45, 48, 52]);
    expect(pianoRhythm(ctx, 'original', 'triad').filter((n) => n.beat === 4).map((n) => n.midi)).toEqual([45, 48, 52, 55]);
  });

  it('labels left-hand chords with the sounding name', () => {
    const ctx = ctxFor({ chordChart: '| C |', tab: '' }, { melody: 0, chord: 2 });
    expect(pianoRhythm(ctx, 'easy', 'triad')[0].chord).toBe('D');
  });

  it('lead on piano: easy keeps the top line, original keeps every note', () => {
    // E + C together on beat 1, then a D on beat 3.
    const ctx = ctxFor({ beatsPerBar: 4, chordChart: '| C |', tabGrid: 2, tab: tab(['0-------', '1---3---', empty, empty, empty, empty]) });
    expect(pianoLead(ctx, 'easy', false, 'triad').map((n) => n.midi)).toEqual([64, 62]);
    expect(pianoLead(ctx, 'original', false, 'triad').map((n) => n.midi)).toEqual([60, 64, 62]);
    const both = pianoLead(ctx, 'easy', true, 'root');
    expect(both.filter((n) => n.hand === 'left').map((n) => n.midi)).toEqual([48]);
  });

  it('lead original uses the full imported tab when there is one', () => {
    const ctx = ctxFor({
      beatsPerBar: 4, tabGrid: 2, chordChart: '',
      tab: tab(['0-------', empty, empty, empty, empty, empty]),
      originalTab: tab(['0-2-----', empty, empty, empty, empty, empty]),
    });
    expect(pianoLead(ctx, 'easy', false, 'triad')).toHaveLength(1);
    expect(pianoLead(ctx, 'original', false, 'triad')).toHaveLength(2);
  });

  it('imported piano parts: original left hand as written, easy right hand as one line', () => {
    const ctx = ctxFor({
      chordChart: '| C |', tab: '',
      piano: { source: 'x', notes: [
        { beat: 0, duration: 1, midi: 72, hand: 'right' }, { beat: 0, duration: 1, midi: 64, hand: 'right' },
        { beat: 0, duration: 4, midi: 36, hand: 'left' }, { beat: 2, duration: 2, midi: 43, hand: 'left' },
      ] },
    });
    expect(pianoLead(ctx, 'easy', false, 'triad').map((n) => n.midi)).toEqual([72]);
    expect(pianoLead(ctx, 'original', false, 'triad').map((n) => n.midi)).toEqual([64, 72]);
    expect(pianoRhythm(ctx, 'original', 'triad').map((n) => [n.beat, n.midi, n.chord])).toEqual([[0, 36, 'C'], [2, 43, 'C']]);
    expect(pianoRhythm(ctx, 'easy', 'root').map((n) => n.midi)).toEqual([48]);
  });

  it('snaps the keyboard to whole octaves', () => {
    const r = keyboardRange([{ beat: 0, duration: 1, midi: 50, hand: 'left' }, { beat: 0, duration: 1, midi: 67, hand: 'right' }]);
    expect(r).toEqual({ lo: 48, hi: 71 });
  });
});

const n = (beat: number, midi: number): PianoNote => ({ beat, duration: 1, midi, hand: 'right' });

describe('practice tracker', () => {
  it('wait mode needs every note of a chord, in any order', () => {
    const t = new PracticeTracker([n(0, 60), n(0, 64), n(0, 67), n(1, 62)], false);
    expect(t.target()?.beat).toBe(0);
    expect(t.noteOn(64, 0, 'wait', 0.2)).toBe(false);
    expect(t.noteOn(61, 0, 'wait', 0.2)).toBe(false); // wrong key
    expect(t.wrong).toBe(1);
    expect(t.noteOn(60, 0, 'wait', 0.2)).toBe(false);
    expect(t.noteOn(67, 0, 'wait', 0.2)).toBe(true);
    expect(t.target()?.beat).toBe(1);
    expect(t.hits).toBe(3);
  });

  it('any-octave mode accepts the note an octave away', () => {
    const t = new PracticeTracker([n(0, 72)], true);
    expect(t.noteOn(60, 0, 'wait', 0.2)).toBe(true);
  });

  it('score mode: hits within the window, misses when the playhead passes', () => {
    const t = new PracticeTracker([n(0, 60), n(1, 62), n(2, 64)], false);
    t.noteOn(60, 0.1, 'score', 0.25);
    t.sync(1.5, 'score', 0.25);
    expect(t.status[0]).toBe(HIT);
    expect(t.status[1]).toBe(MISS);
    t.noteOn(65, 2, 'score', 0.25); // wrong note
    t.noteOn(64, 2.2, 'score', 0.25);
    expect(t.status[2]).toBe(HIT);
    expect([t.hits, t.misses, t.wrong]).toEqual([2, 1, 1]);
    expect(t.accuracy()).toBe(50);
  });

  it('seeking back re-arms the notes (loop practice)', () => {
    const t = new PracticeTracker([n(0, 60), n(1, 62)], false);
    t.noteOn(60, 0, 'wait', 0.2);
    t.noteOn(62, 1, 'wait', 0.2);
    t.sync(1.2, 'wait', 0.2);
    t.sync(0, 'wait', 0.2);
    expect(t.target()?.beat).toBe(0);
    expect(t.status[0]).toBe(0);
  });
});
