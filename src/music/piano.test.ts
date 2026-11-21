import { describe, expect, it } from 'vitest';
import { buildArrangement } from './arrangement';
import { buildPianoPart, keyboardRange, leftHandVoicing, type PianoNote } from './piano';
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

  it('builds both hands from the arrangement, re-striking long chords each bar', () => {
    const arr = buildArrangement(song({
      beatsPerBar: 4,
      chordChart: '| C . . . | Am |',
      tab: ['e|0-------|', 'B|--1-----|', 'G|--------|', 'D|--------|', 'A|--------|', 'E|--------|'].join('\n'),
      tabGrid: 2,
    }));
    const part = buildPianoPart(arr, { melodyShift: 0, chordShift: 0, leftStyle: 'root' });
    const left = part.filter((n) => n.hand === 'left');
    expect(left.map((n) => [n.beat, n.midi, n.chord])).toEqual([[0, 48, 'C'], [4, 45, 'Am']]);
    const right = part.filter((n) => n.hand === 'right').map((n) => n.midi);
    // high E (64) and C on the B string (60): already around middle C, no octave shift
    expect(right).toEqual([64, 60]);
  });

  it('labels left-hand chords with the sounding name', () => {
    const arr = buildArrangement(song({ chordChart: '| C |', tab: '' }));
    const part = buildPianoPart(arr, { melodyShift: 0, chordShift: 2, leftStyle: 'triad' });
    expect(part[0].chord).toBe('D');
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
