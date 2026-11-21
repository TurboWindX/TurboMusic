/**
 * Piano lane: notes fall onto an on-screen keyboard; a USB MIDI keyboard is checked
 * against them (wait mode pauses the song until you play the right keys).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { engine, type Position } from '../audio/engine';
import { midi, useMidi } from '../audio/midi';
import { isBlack, keyboardRange, noteName, type PianoNote } from '../music/piano';
import { HIT, MISS, PracticeTracker, type PracticeMode } from '../music/practice';
import { partKeys, useSettings, type Role } from '../state/settings';
import { PartControls } from './PartControls';
import { useFrame } from './hooks';

interface Props {
  notes: PianoNote[];
  beatsPerBar: number;
  /** Effective tempo (song bpm x speed), for timing tolerance. */
  bpm: number;
  playerName: string;
  role: Role;
  /** Both players are on piano: offer to tie each lane to its own MIDI keyboard. */
  shared?: boolean;
}

const COLORS = {
  right: '#5fb3ff',
  left: '#ffb454',
  hit: '#7bd88f',
  miss: '#ff6b81',
  grid: '#232838',
  bar: '#3a4157',
  text: '#e9ecf3',
  muted: '#8b92a7',
};
const TIMING_WINDOW_S = 0.2;

/**
 * Lanes currently holding the song in wait mode. With two piano players, both get asked
 * at the same moment, and the song only carries on once nobody is waiting any more.
 */
const holding = new Set<object>();

const MODES: [PracticeMode, string, string][] = [
  ['wait', 'wait for me', 'The song stops at each note until you play it'],
  ['score', 'score', 'The song keeps going; you get a hit for each note played in time'],
  ['watch', 'just watch', 'No checking, just the falling notes'],
];

export function PianoLane({ notes, beatsPerBar, bpm, playerName, role, shared }: Props) {
  const s = useSettings();
  const midiState = useMidi();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [waitingFor, setWaitingFor] = useState<number[] | null>(null);
  const [score, setScore] = useState({ hits: 0, misses: 0, wrong: 0, streak: 0, best: 0, acc: null as number | null });

  const inputKey = partKeys[role].midi;
  const input = shared ? s[inputKey] : '';
  const range = useMemo(() => keyboardRange(notes), [notes]);
  const tracker = useMemo(() => {
    const t = new PracticeTracker(notes, s.pianoAnyOctave);
    t.rewind(engine.getPosition().beat);
    return t;
  }, [notes, s.pianoAnyOctave]);

  /** Left-hand notes that start a new chord get its name drawn next to them. */
  const labelAt = useMemo(() => {
    const out = new Set<number>();
    let last: string | undefined;
    tracker.notes.forEach((n, i) => {
      if (n.hand !== 'left' || !n.chord) return;
      if (n.chord !== last && (i === 0 || tracker.notes[i - 1].beat !== n.beat || tracker.notes[i - 1].hand !== 'left')) out.add(i);
      last = n.chord;
    });
    return out;
  }, [tracker]);
  const labelRef = useRef(labelAt);
  labelRef.current = labelAt;

  const tolBeats = (TIMING_WINDOW_S * bpm) / 60;
  const live = useRef({ tracker, mode: s.pianoPractice, tolBeats, waiting: false, resuming: false });
  live.current.tracker = tracker;
  live.current.mode = s.pianoPractice;
  live.current.tolBeats = tolBeats;
  const inputRef = useRef(input);
  inputRef.current = input;

  // Leaving wait mode (or swapping hands) cancels any wait in progress and starts a fresh score.
  useEffect(() => {
    live.current.waiting = false;
    holding.delete(live.current);
    setWaitingFor(null);
    tracker.resetScore();
    tracker.rewind(engine.getPosition().beat);
  }, [s.pianoPractice, tracker]);

  const resume = async (fromBeat: number) => {
    const L = live.current;
    L.waiting = false;
    holding.delete(L);
    setWaitingFor(null);
    if (holding.size) return; // the other player hasn't played their part yet
    L.resuming = true;
    engine.countInEnabled = false;
    try {
      // Just past the chord you played, so its guitar part isn't struck a second time.
      await engine.play(fromBeat + 0.001);
    } finally {
      engine.countInEnabled = useSettings.getState().countIn;
      L.resuming = false;
    }
  };

  // --- MIDI keyboard
  useEffect(() => {
    void midi.connect();
    const offNote = midi.onNote((e) => {
      // Two piano players: each lane only listens to its own keyboard (on-screen keys always count).
      const mine = !inputRef.current || e.device === inputRef.current || e.device === 'screen';
      if (e.type === 'off') { if (mine) engine.keyUp(e.midi); return; }
      if (!mine) return;
      const st = useSettings.getState();
      if (st.midiSound) { engine.keysVolume = st.volKeys; void engine.keyDown(e.midi, e.velocity); }
      const L = live.current;
      const done = L.tracker.noteOn(e.midi, engine.getPosition().beat, L.mode, L.tolBeats);
      if (done && L.waiting) {
        const g = L.tracker.groups[L.tracker.cur - 1];
        void resume(g.beat);
      }
    });
    const offPedal = midi.onPedal((down) => engine.setSustain(down));
    const me = live.current;
    return () => { offNote(); offPedal(); holding.delete(me); };
  }, []);

  // --- per-frame: follow the playhead, pause for wait mode, draw
  const geom = useRef({ w: 0, h: 0, dpr: 1 });
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const c = canvas.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      geom.current = { w: el.clientWidth, h: el.clientHeight, dpr };
      c.width = Math.round(el.clientWidth * dpr);
      c.height = Math.round(el.clientHeight * dpr);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lastScore = useRef('');
  useFrame((pos) => {
    const L = live.current;
    const t = L.tracker;
    if (!pos.countIn && !L.resuming) t.sync(pos.beat, L.mode, L.tolBeats);
    // Stop at this lane's next note while playing, or join a wait another lane started at the same spot.
    if (L.mode === 'wait' && !L.waiting && !pos.countIn && !L.resuming && (pos.playing || holding.size)) {
      const g = t.target();
      if (g && pos.beat >= g.beat - 0.005 && (pos.playing || Math.abs(pos.beat - g.beat) < 0.01)) {
        if (pos.playing) { engine.pause(); engine.seek(g.beat); }
        L.waiting = true;
        holding.add(L);
        setWaitingFor(g.idx.map((i) => t.notes[i].midi));
      }
    }
    const key = `${t.hits}/${t.misses}/${t.wrong}/${t.streak}`;
    if (key !== lastScore.current) {
      lastScore.current = key;
      setScore({ hits: t.hits, misses: t.misses, wrong: t.wrong, streak: t.streak, best: t.best, acc: t.accuracy() });
    }
    draw(pos);
  });

  // --- drawing
  const keyLayout = useMemo(() => {
    const whites: number[] = [];
    for (let m = range.lo; m <= range.hi; m++) if (!isBlack(m)) whites.push(m);
    return { whites };
  }, [range]);

  const keyRect = (m: number, w: number) => {
    const ww = w / keyLayout.whites.length;
    if (!isBlack(m)) return { x: keyLayout.whites.indexOf(m) * ww, w: ww, black: false };
    const next = keyLayout.whites.indexOf(m + 1);
    const bw = ww * 0.6;
    return { x: next * ww - bw / 2, w: bw, black: true };
  };

  const keyboardHeight = (h: number) => Math.max(70, Math.min(170, h * 0.28));

  function draw(pos: Position) {
    const c = canvas.current;
    const { w, h, dpr } = geom.current;
    if (!c || !w || !h) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const L = live.current;
    const t = L.tracker;
    const ppb = useSettings.getState().pianoZoom;
    const beat = pos.beat;
    const kh = keyboardHeight(h);
    const hitY = h - kh;
    const yOf = (b: number) => hitY - (b - beat) * ppb;
    const topBeat = beat + hitY / ppb;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Octave guides (C lines) and beat/bar grid.
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    for (const m of keyLayout.whites) if (m % 12 === 0) { const r = keyRect(m, w); ctx.fillRect(r.x, 0, 1, hitY); }
    for (let b = Math.ceil(beat - 0.001); b <= topBeat; b++) {
      const y = yOf(b);
      const isBar = b % beatsPerBar === 0;
      ctx.fillStyle = isBar ? COLORS.bar : COLORS.grid;
      ctx.fillRect(0, y, w, isBar ? 2 : 1);
      if (isBar) {
        ctx.fillStyle = COLORS.muted;
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(String(b / beatsPerBar + 1), 6, y - 5);
      }
    }

    // Falling notes.
    const target = L.waiting || L.mode === 'wait' ? t.target() : null;
    const targetSet = new Set(target?.idx ?? []);
    const sounding = new Map<number, string>(); // midi -> colour, for lighting keys
    const chordLabels: { x: number; y: number; text: string }[] = [];
    for (let i = 0; i < t.notes.length; i++) {
      const n = t.notes[i];
      if (n.beat > topBeat) break;
      if (n.beat + n.duration < beat - 0.5) continue;
      const r = keyRect(n.midi, w);
      const yBottom = yOf(n.beat);
      const yTop = yOf(n.beat + n.duration) + 2;
      const st = t.status[i];
      const base = n.hand === 'right' ? COLORS.right : COLORS.left;
      const color = st === HIT ? COLORS.hit : st === MISS ? COLORS.miss : base;
      const isNow = beat >= n.beat - 0.02 && beat < n.beat + n.duration;
      if (isNow || targetSet.has(i)) sounding.set(n.midi, base);
      ctx.globalAlpha = st === MISS ? 0.45 : yTop > hitY ? 0.35 : 1; // dim once fully played
      ctx.fillStyle = color;
      const pad = r.black ? 1 : 2;
      roundRect(ctx, r.x + pad, yTop, r.w - pad * 2, Math.max(6, Math.min(yBottom, h) - yTop), 6);
      ctx.fill();
      if (targetSet.has(i)) {
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(performance.now() / 150);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (r.w >= 16 && yBottom - yTop >= 18) {
        ctx.fillStyle = '#0b1220';
        ctx.font = `800 ${Math.min(16, r.w * 0.45)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(noteName(n.midi), r.x + r.w / 2, Math.min(yBottom, hitY) - 6);
      }
      if (n.chord && labelRef.current.has(i)) {
        chordLabels.push({ x: r.x - 6, y: Math.min(yBottom, hitY) - 6, text: n.chord });
      }
    }
    ctx.font = '800 18px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.left;
    for (const l of chordLabels) ctx.fillText(l.text, l.x, l.y);

    // Hit line.
    ctx.fillStyle = 'rgba(123,216,143,0.9)';
    ctx.fillRect(0, hitY - 2, w, 3);

    // Keyboard.
    const held = midi.held;
    const keyFill = (m: number, black: boolean) => {
      if (held.has(m)) return t.notes.length && !L.tracker.expects(m, beat, L.mode, L.tolBeats) && L.mode !== 'watch' ? COLORS.miss : COLORS.hit;
      const s2 = sounding.get(m);
      if (s2) return s2;
      return black ? '#151821' : '#eef1f6';
    };
    const ww = w / keyLayout.whites.length;
    for (const m of keyLayout.whites) {
      const r = keyRect(m, w);
      ctx.fillStyle = keyFill(m, false);
      roundRect(ctx, r.x + 1, hitY + 2, r.w - 2, kh - 4, 5);
      ctx.fill();
      if (ww >= 18) {
        ctx.fillStyle = m % 12 === 0 ? '#1b2233' : '#8a93a8';
        ctx.font = `${m % 12 === 0 ? 800 : 600} ${Math.min(14, ww * 0.42)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(m % 12 === 0 ? `C${m / 12 - 1}` : noteName(m), r.x + r.w / 2, h - 10);
      }
    }
    for (let m = range.lo; m <= range.hi; m++) {
      if (!isBlack(m)) continue;
      const r = keyRect(m, w);
      ctx.fillStyle = keyFill(m, true);
      roundRect(ctx, r.x, hitY + 2, r.w, (kh - 4) * 0.62, 4);
      ctx.fill();
    }
  }

  // --- on-screen keyboard (mouse / touch) behaves like a MIDI key
  const pointerKey = useRef<number | null>(null);
  const keyAt = (x: number, y: number): number | null => {
    const { w, h } = geom.current;
    const kh = keyboardHeight(h);
    if (y < h - kh) return null;
    if (y < h - kh + (kh - 4) * 0.62) {
      for (let m = range.lo; m <= range.hi; m++) {
        if (!isBlack(m)) continue;
        const r = keyRect(m, w);
        if (x >= r.x && x < r.x + r.w) return m;
      }
    }
    for (const m of keyLayout.whites) {
      const r = keyRect(m, w);
      if (x >= r.x && x < r.x + r.w) return m;
    }
    return null;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const m = keyAt(e.clientX - rect.left, e.clientY - rect.top);
    if (m === null) return;
    pointerKey.current = m;
    midi.emit({ type: 'on', midi: m, velocity: 0.7, device: 'screen' });
  };
  const onPointerUp = () => {
    if (pointerKey.current === null) return;
    midi.emit({ type: 'off', midi: pointerKey.current, velocity: 0, device: 'screen' });
    pointerKey.current = null;
  };

  const status = midiStatusText(midiState.status, midiState.devices);

  return (
    <section className={`lane piano-lane ${role === 'lead' ? 'melody-lane' : 'chord-lane rhythm-piano'}`}>
      <header className="lane-head">
        <span className={`lane-who ${role === 'lead' ? 'melody' : 'chords'}`}>{playerName}</span>
        <span className="lane-what">{role === 'lead' ? 'melody' : 'chords'}</span>
        <PartControls role={role} />
        {role === 'lead' && (
          <button
            className={`chip${s.leadBothHands ? ' active' : ''}`}
            onClick={() => s.set({ leadBothHands: !s.leadBothHands })}
            title="Also play the left hand (chords): one person plays the whole piano part"
          >+ left hand</button>
        )}
        <div className="chip-row">
          {MODES.map(([v, label, title]) => (
            <button key={v} title={title} className={`chip${s.pianoPractice === v ? ' active' : ''}`} onClick={() => s.set({ pianoPractice: v })}>{label}</button>
          ))}
        </div>
        {waitingFor && (
          <span className="piano-waiting">
            your turn: <b>{[...new Set(waitingFor.map(noteName))].join(' ')}</b>
          </span>
        )}
        {s.pianoPractice !== 'watch' && (
          <span className="piano-score" title="hits · missed · wrong keys">
            <b className="good">{score.hits}</b> hit
            {s.pianoPractice === 'score' && <> · <b className="bad">{score.misses}</b> missed</>}
            {' '}· <b>{score.wrong}</b> wrong
            {score.acc !== null && <> · <b>{score.acc}%</b></>}
            {score.best > 4 && <> · best streak <b>{score.best}</b></>}
            <button className="btn ghost small" onClick={() => { tracker.resetScore(); tracker.rewind(engine.getPosition().beat); }} title="Reset score">↺</button>
          </span>
        )}
        {shared && midiState.devices.length > 1 && (
          <select className="midi-input" value={input} onChange={(e) => s.set({ [inputKey]: e.target.value })} title="Which keyboard this player uses">
            <option value="">any keyboard</option>
            {midiState.devices.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        <span className={`pill midi-pill ${status.cls}`} title={midiState.error ?? status.title}>
          🎹 {status.text}
          {(midiState.status === 'idle' || midiState.status === 'denied') && (
            <button className="btn ghost small" onClick={() => void midi.connect()}>connect</button>
          )}
        </span>
      </header>
      <div
        className="piano-canvas-wrap"
        ref={wrap}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <canvas ref={canvas} />
      </div>
    </section>
  );
}

function midiStatusText(status: string, devices: string[]): { text: string; cls: string; title: string } {
  switch (status) {
    case 'ready':
      return devices.length
        ? { text: devices.join(', '), cls: 'midi-ok', title: 'MIDI keyboard connected' }
        : { text: 'plug in a USB keyboard', cls: 'midi-warn', title: 'No MIDI keyboard found. Plug one in; it is picked up automatically.' };
    case 'asking': return { text: 'allow MIDI in the browser prompt', cls: 'midi-warn', title: '' };
    case 'denied': return { text: 'MIDI blocked', cls: 'midi-bad', title: 'Allow MIDI devices for this site in the browser settings, then press connect.' };
    case 'unsupported': return { text: 'use Chrome or Edge for MIDI', cls: 'midi-bad', title: 'This browser cannot read MIDI keyboards.' };
    case 'insecure': return { text: 'MIDI needs localhost or https', cls: 'midi-bad', title: 'Open the app via http://localhost or an https tunnel, not a plain LAN IP.' };
    default: return { text: 'keyboard not connected', cls: '', title: '' };
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), rr);
}
