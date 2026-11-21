/**
 * Audio engine: lookahead scheduler on the Web Audio clock.
 *
 * Position mapping is piecewise-linear: a list of segments {time, beat}
 * (one per start/seek/tempo change/loop wrap) at a constant seconds-per-beat.
 * The UI reads positions via getPosition(), so visuals and sound share one clock.
 */
import { midiToFreq } from '../music/theory';

export interface NoteEv { beat: number; midi: number }
export interface StrumEv { beat: number; midi: number[]; dir: 'D' | 'U' }

export type Part = 'melody' | 'chords' | 'click';

interface Segment { time: number; beat: number; spb: number }

export interface Position {
  beat: number;
  playing: boolean;
  /** Remaining count-in beats (4,3,2,1) or 0. */
  countIn: number;
}

const LOOKAHEAD = 0.12; // seconds scheduled ahead
const TICK_MS = 25;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buses = {} as Record<Part, GainNode>;
  private master!: GainNode;
  private buffers = new Map<number, AudioBuffer>();
  private sources = new Set<{ src: AudioScheduledSourceNode; start: number }>();

  private melody: NoteEv[] = [];
  private strums: StrumEv[] = [];
  private beatsPerBar = 4;
  private totalBeats = 0;
  private bpm = 80;
  private speed = 1;
  private capo = 0;

  private segments: Segment[] = [];
  private schedBeat = 0;
  private timer: number | null = null;
  private endTime: number | null = null;
  private stoppedBeat = 0;
  private countInUntil = 0;

  loop: { start: number; end: number } | null = null;
  metronome = true;
  countInEnabled = true;
  /** Manual A/V offset in ms (positive = visuals later). */
  latencyMs = 0;
  onEnded: (() => void) | null = null;

  private volumes: Record<Part, number> = { melody: 0.9, chords: 0.6, click: 0.5 };
  private muted: Record<Part, boolean> = { melody: false, chords: false, click: false };

  /** Must be called from a user gesture the first time (autoplay policy). */
  async ensure(): Promise<AudioContext> {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(ctx.destination);
      for (const part of ['melody', 'chords', 'click'] as Part[]) {
        const g = ctx.createGain();
        if (part === 'click') {
          g.connect(this.master);
        } else {
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = part === 'melody' ? 5200 : 3800;
          g.connect(lp).connect(this.master);
        }
        this.buses[part] = g;
      }
      this.ctx = ctx;
      this.applyGains();
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.ctx;
  }

  get context() { return this.ctx; }

  load(opts: { melody: NoteEv[]; strums: StrumEv[]; beatsPerBar: number; totalBeats: number; bpm: number; capo: number }) {
    this.melody = [...opts.melody].sort((a, b) => a.beat - b.beat);
    this.strums = [...opts.strums].sort((a, b) => a.beat - b.beat);
    this.beatsPerBar = opts.beatsPerBar;
    this.totalBeats = opts.totalBeats;
    this.capo = opts.capo;
    const tempoChanged = opts.bpm !== this.bpm;
    this.bpm = opts.bpm;
    if (tempoChanged && this.isPlaying()) this.retime();
    if (this.ctx) this.prewarm();
  }

  setSpeed(speed: number) {
    this.speed = Math.max(0.25, Math.min(1.5, speed));
    if (this.isPlaying()) this.retime();
  }

  setVolume(part: Part, v: number) { this.volumes[part] = v; this.applyGains(); }
  setMuted(part: Part, m: boolean) { this.muted[part] = m; this.applyGains(); }

  private applyGains() {
    if (!this.ctx) return;
    for (const p of Object.keys(this.buses) as Part[]) {
      this.buses[p].gain.setTargetAtTime(this.muted[p] ? 0 : this.volumes[p], this.ctx.currentTime, 0.02);
    }
  }

  private get spb() { return 60 / (this.bpm * this.speed); }

  isPlaying() { return this.timer !== null; }

  async play(fromBeat?: number) {
    const ctx = await this.ensure();
    this.prewarm();
    if (this.isPlaying()) this.stopTimer();
    let start = fromBeat ?? this.stoppedBeat;
    if (this.loop && (start < this.loop.start || start >= this.loop.end)) start = this.loop.start;
    if (start >= this.totalBeats) start = 0;
    const spb = this.spb;
    let t0 = ctx.currentTime + 0.08;
    if (this.countInEnabled) {
      for (let i = 0; i < this.beatsPerBar; i++) this.click(t0 + i * spb, i === 0, true);
      t0 += this.beatsPerBar * spb;
    }
    this.countInUntil = t0;
    this.segments = [{ time: t0, beat: start, spb }];
    this.schedBeat = start;
    this.endTime = null;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  pause() {
    if (!this.isPlaying()) return;
    this.stoppedBeat = Math.max(0, this.getPosition().beat);
    this.stopTimer();
    this.silenceFuture();
  }

  stop() {
    this.pause();
    this.stoppedBeat = this.loop?.start ?? 0;
  }

  seek(beat: number) {
    const b = Math.max(0, Math.min(this.totalBeats - 0.001, beat));
    if (!this.isPlaying()) { this.stoppedBeat = b; return; }
    const ctx = this.ctx!;
    this.silenceFuture();
    const t = ctx.currentTime + 0.05;
    this.segments = [{ time: t, beat: b, spb: this.spb }];
    this.countInUntil = 0;
    this.schedBeat = b;
    this.endTime = null;
  }

  getPosition(): Position {
    if (!this.ctx || !this.isPlaying()) return { beat: this.stoppedBeat, playing: false, countIn: 0 };
    const out = (this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? this.ctx.baseLatency ?? 0;
    const now = this.ctx.currentTime - out - this.latencyMs / 1000;
    if (this.endTime !== null && this.ctx.currentTime >= this.endTime) {
      this.stopTimer();
      this.stoppedBeat = 0;
      queueMicrotask(() => this.onEnded?.());
      return { beat: 0, playing: false, countIn: 0 };
    }
    let seg = this.segments[0];
    for (const s of this.segments) if (s.time <= now) seg = s;
    const beat = seg.beat + (now - seg.time) / seg.spb;
    const countIn = now < this.countInUntil ? Math.ceil((this.countInUntil - now) / seg.spb) : 0;
    return { beat: countIn ? seg.beat : Math.max(0, beat), playing: true, countIn };
  }

  // ---------------------------------------------------------------- internals

  private stopTimer() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-anchor at the scheduling frontier so a tempo change is seamless. */
  private retime() {
    const seg = this.segments[this.segments.length - 1];
    const t = seg.time + (this.schedBeat - seg.beat) * seg.spb;
    this.segments.push({ time: t, beat: this.schedBeat, spb: this.spb });
    this.trimSegments();
  }

  private trimSegments() {
    const now = this.ctx!.currentTime - 1;
    while (this.segments.length > 2 && this.segments[1].time < now) this.segments.shift();
  }

  private tick() {
    const ctx = this.ctx!;
    const horizon = ctx.currentTime + LOOKAHEAD;
    for (let guard = 0; guard < 8; guard++) {
      const seg = this.segments[this.segments.length - 1];
      const horizonBeat = seg.beat + (horizon - seg.time) / seg.spb;
      if (horizonBeat <= this.schedBeat) break;
      const limit = this.loop ? Math.min(this.loop.end, this.totalBeats) : this.totalBeats;
      if (horizonBeat >= limit) {
        this.scheduleRange(this.schedBeat, limit, seg);
        const tEnd = seg.time + (limit - seg.beat) * seg.spb;
        if (this.loop) {
          this.segments.push({ time: tEnd, beat: this.loop.start, spb: seg.spb });
          this.schedBeat = this.loop.start;
          this.trimSegments();
          continue;
        }
        this.schedBeat = limit;
        this.endTime = tEnd + 1.5; // let the last notes ring
        break;
      }
      this.scheduleRange(this.schedBeat, horizonBeat, seg);
      this.schedBeat = horizonBeat;
      break;
    }
  }

  private scheduleRange(b0: number, b1: number, seg: Segment) {
    const at = (beat: number) => seg.time + (beat - seg.beat) * seg.spb;
    const eps = 1e-6;
    for (const n of rangeOf(this.melody, b0 - eps, b1 - eps)) {
      this.pluck('melody', n.midi + this.capo, at(n.beat), 0.85);
    }
    for (const s of rangeOf(this.strums, b0 - eps, b1 - eps)) {
      const notes = s.dir === 'D' ? s.midi : [...s.midi].reverse().slice(0, 4);
      const onBeat = Math.abs(s.beat - Math.round(s.beat)) < eps;
      const vel = (s.dir === 'D' ? 0.55 : 0.4) * (onBeat ? 1 : 0.85);
      notes.forEach((m, i) => this.pluck('chords', m + this.capo, at(s.beat) + i * 0.014, vel));
    }
    if (this.metronome) {
      for (let k = Math.ceil(b0 - eps); k < b1 - eps; k++) {
        this.click(at(k), k % this.beatsPerBar === 0, false);
      }
    }
  }

  private click(time: number, accent: boolean, countIn: boolean) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1100;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(countIn ? 0.6 : accent ? 0.45 : 0.3, time + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(g).connect(countIn ? this.master : this.buses.click);
    osc.start(time);
    osc.stop(time + 0.06);
    this.track(osc, time);
  }

  private pluck(part: Part, midi: number, time: number, vel: number) {
    const ctx = this.ctx!;
    const buf = this.buffer(midi);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (buf as AudioBuffer & { rate?: number }).rate ?? 1;
    const g = ctx.createGain();
    g.gain.value = vel;
    src.connect(g).connect(this.buses[part]);
    src.start(time);
    this.track(src, time);
  }

  private track(src: AudioScheduledSourceNode, start: number) {
    const entry = { src, start };
    this.sources.add(entry);
    src.onended = () => this.sources.delete(entry);
  }

  private silenceFuture() {
    const now = this.ctx?.currentTime ?? 0;
    for (const e of this.sources) {
      if (e.start > now) {
        try { e.src.stop(); } catch { /* not started */ }
        this.sources.delete(e);
      }
    }
  }

  private prewarm() {
    const needed = new Set<number>();
    this.melody.forEach((n) => needed.add(n.midi + this.capo));
    this.strums.forEach((s) => s.midi.forEach((m) => needed.add(m + this.capo)));
    needed.forEach((m) => this.buffer(m));
  }

  /** Karplus-Strong plucked string, cached per MIDI note. */
  private buffer(midi: number): AudioBuffer {
    const cached = this.buffers.get(midi);
    if (cached) return cached;
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const f = midiToFreq(midi);
    const N = Math.max(2, Math.floor(sr / f - 0.5));
    const t60 = Math.max(1.2, Math.min(4, 4 - (midi - 40) * 0.07));
    const len = Math.floor(sr * Math.min(3, t60));
    const buf = ctx.createBuffer(1, len, sr);
    const y = buf.getChannelData(0);
    // Excitation: filtered noise burst (pluck brightness).
    let lp = 0;
    for (let i = 0; i < N; i++) {
      lp = lp * 0.5 + (Math.random() * 2 - 1) * 0.5;
      y[i] = lp;
    }
    const decay = Math.pow(0.001, (N / sr) / t60);
    for (let i = N; i < len; i++) {
      y[i] = decay * 0.5 * (y[i - N] + y[i - N - 1 < 0 ? 0 : i - N - 1]);
    }
    // Fade tail, normalise.
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(y[i]));
    const fadeStart = len - Math.floor(sr * 0.2);
    for (let i = 0; i < len; i++) {
      y[i] = (y[i] / (peak || 1)) * 0.8 * (i > fadeStart ? (len - i) / (len - fadeStart) : 1);
    }
    // KS pitch = sr / (N + 0.5); correct the residual with playbackRate.
    (buf as AudioBuffer & { rate?: number }).rate = f / (sr / (N + 0.5));
    this.buffers.set(midi, buf);
    return buf;
  }
}

/** Events with lo <= beat < hi (array sorted by beat). */
function rangeOf<T extends { beat: number }>(arr: T[], lo: number, hi: number): T[] {
  let a = 0, b = arr.length;
  while (a < b) { const m = (a + b) >> 1; if (arr[m].beat < lo) a = m + 1; else b = m; }
  const out: T[] = [];
  for (let i = a; i < arr.length && arr[i].beat < hi; i++) out.push(arr[i]);
  return out;
}

export const engine = new AudioEngine();
