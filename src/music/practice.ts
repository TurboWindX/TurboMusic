/**
 * Play-along logic for the piano part, independent of audio and UI so it can be tested.
 *
 * wait  — the song stops at each note/chord until you play it (the app pauses the engine).
 * score — the song keeps going; each note is a hit if you play it close enough in time.
 * watch — no checking, just the falling notes.
 */
import type { PianoNote } from './piano';

export type PracticeMode = 'wait' | 'score' | 'watch';

export const PENDING = 0;
export const HIT = 1;
export const MISS = 2;

interface Group { beat: number; idx: number[] }

export class PracticeTracker {
  readonly notes: PianoNote[];
  readonly status: Uint8Array;
  readonly groups: Group[];
  hits = 0;
  misses = 0;
  wrong = 0;
  streak = 0;
  best = 0;
  /** Wait mode: index of the group we're waiting on. */
  cur = 0;
  private pressed = new Set<number>();
  private sweepIdx = 0;
  private lastBeat = 0;

  constructor(notes: PianoNote[], private anyOctave: boolean) {
    this.notes = notes;
    this.status = new Uint8Array(notes.length);
    const groups: Group[] = [];
    notes.forEach((n, i) => {
      const g = groups[groups.length - 1];
      if (g && Math.abs(g.beat - n.beat) < 0.02) g.idx.push(i);
      else groups.push({ beat: n.beat, idx: [i] });
    });
    this.groups = groups;
  }

  private match(a: number, b: number) {
    return this.anyOctave ? (a - b) % 12 === 0 : a === b;
  }

  /** The chord/note wait mode is currently asking for. */
  target(): Group | null {
    return this.groups[this.cur] ?? null;
  }

  /** Clear results from `beat` on (after a seek backwards or a loop wrap) and re-arm. */
  rewind(beat: number) {
    for (let i = 0; i < this.notes.length; i++) if (this.notes[i].beat >= beat - 0.01) this.status[i] = PENDING;
    this.cur = this.firstGroupFrom(beat);
    this.sweepIdx = this.firstNoteFrom(beat);
    this.pressed.clear();
    this.lastBeat = beat;
  }

  /** Follow the playhead: detects seeks/loop wraps; in score mode marks late notes as missed. */
  sync(beat: number, mode: PracticeMode, tolBeats: number) {
    if (beat < this.lastBeat - 0.25) this.rewind(beat);
    else if (beat > this.lastBeat + 1.5) {
      // Jumped forward: skip what we jumped over without counting it.
      this.cur = Math.max(this.cur, this.firstGroupFrom(beat));
      this.sweepIdx = Math.max(this.sweepIdx, this.firstNoteFrom(beat));
      this.pressed.clear();
    }
    this.lastBeat = beat;
    if (mode !== 'score') return;
    while (this.sweepIdx < this.notes.length && this.notes[this.sweepIdx].beat < beat - tolBeats) {
      if (this.status[this.sweepIdx] === PENDING) {
        this.status[this.sweepIdx] = MISS;
        this.misses++;
        this.streak = 0;
      }
      this.sweepIdx++;
    }
  }

  /**
   * A key was pressed. Returns true when (in wait mode) it completed the awaited group,
   * meaning the song can carry on.
   */
  noteOn(midi: number, beat: number, mode: PracticeMode, tolBeats: number): boolean {
    if (mode === 'wait') return this.waitNoteOn(midi);
    if (mode === 'score') this.scoreNoteOn(midi, beat, tolBeats);
    return false;
  }

  private waitNoteOn(midi: number): boolean {
    const g = this.target();
    if (!g) return false;
    if (!g.idx.some((i) => this.match(this.notes[i].midi, midi))) {
      this.wrong++;
      this.streak = 0;
      return false;
    }
    this.pressed.add(midi);
    const done = g.idx.every((i) => [...this.pressed].some((p) => this.match(this.notes[i].midi, p)));
    if (!done) return false;
    for (const i of g.idx) this.status[i] = HIT;
    this.hits += g.idx.length;
    this.streak += g.idx.length;
    this.best = Math.max(this.best, this.streak);
    this.cur++;
    this.pressed.clear();
    return true;
  }

  private scoreNoteOn(midi: number, beat: number, tol: number) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = this.sweepIdx; i < this.notes.length && this.notes[i].beat <= beat + tol; i++) {
      if (this.status[i] !== PENDING || !this.match(this.notes[i].midi, midi)) continue;
      const d = Math.abs(this.notes[i].beat - beat);
      if (d <= tol && d < bestDist) { best = i; bestDist = d; }
    }
    if (best < 0) {
      this.wrong++;
      this.streak = 0;
      return;
    }
    this.status[best] = HIT;
    this.hits++;
    this.streak++;
    this.best = Math.max(this.best, this.streak);
  }

  /** Is this pitch something the player should be playing around `beat`? (for key colouring) */
  expects(midi: number, beat: number, mode: PracticeMode, tolBeats: number): boolean {
    if (mode === 'wait') {
      const g = this.target();
      return !!g && g.idx.some((i) => this.match(this.notes[i].midi, midi));
    }
    for (const n of this.notes) {
      if (n.beat > beat + tolBeats) break;
      if (beat < n.beat + n.duration + tolBeats && beat >= n.beat - tolBeats && this.match(n.midi, midi)) return true;
    }
    return false;
  }

  accuracy(): number | null {
    const total = this.hits + this.misses + this.wrong;
    return total ? Math.round((this.hits / total) * 100) : null;
  }

  resetScore() {
    this.hits = this.misses = this.wrong = this.streak = this.best = 0;
  }

  private firstGroupFrom(beat: number) {
    const i = this.groups.findIndex((g) => g.beat >= beat - 0.01);
    return i < 0 ? this.groups.length : i;
  }

  private firstNoteFrom(beat: number) {
    const i = this.notes.findIndex((n) => n.beat >= beat - 0.01);
    return i < 0 ? this.notes.length : i;
  }
}
