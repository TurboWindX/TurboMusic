/**
 * Chord-change drill: alternate two chords on a click. Count clean changes
 * in 60 s ("one-minute changes") or just play along at a set tempo.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { resolveChord } from '../music/chords';
import { parseChord } from '../music/theory';
import { ChordDiagram } from '../components/ChordDiagram';
import { useQuantizedPosition } from '../components/hooks';
import { useSettings } from '../state/settings';
import { isTyping } from '../components/keys';

const PRESETS = [['C', 'G'], ['G', 'D'], ['Am', 'E'], ['C', 'Am'], ['F', 'C'], ['Em', 'G'], ['D', 'A']];
const BARS = 64;

export function DrillView({ initial }: { initial?: string[] }) {
  const easy = useSettings((s) => s.rhythmLevel === 'easy');
  const [a, setA] = useState(initial?.[0] ?? 'C');
  const [b, setB] = useState(initial?.[1] ?? 'G');
  const [bpm, setBpm] = useState(60);
  const [beatsEach, setBeatsEach] = useState(4);
  const [count, setCount] = useState(0);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  const pos = useQuantizedPosition(1);

  const ra = useMemo(() => resolveChord(a, { easy }), [a, easy]);
  const rb = useMemo(() => resolveChord(b, { easy }), [b, easy]);
  const valid = !!parseChord(a) && !!parseChord(b);

  useEffect(() => {
    const strums = [];
    const total = BARS * 4;
    for (let beat = 0; beat < total; beat++) {
      const which = Math.floor(beat / beatsEach) % 2 === 0 ? ra : rb;
      strums.push({ beat, dir: 'D' as const, midi: which.midi });
    }
    engine.load({ melody: [], strums, beatsPerBar: 4, totalBeats: total, bpm, capo: 0 });
    engine.loop = { start: 0, end: total };
    engine.metronome = true;
    engine.setSpeed(1);
    engine.setMuted('chords', false);
  }, [ra, rb, bpm, beatsEach]);

  useEffect(() => () => {
    engine.stop();
    engine.loop = null;
    if (timer.current) clearInterval(timer.current);
  }, []);

  const startMinute = () => {
    setCount(0);
    setTimeLeft(60);
    if (timer.current) clearInterval(timer.current);
    const end = Date.now() + 60_000;
    timer.current = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setTimeLeft(left);
      if (left === 0 && timer.current) { clearInterval(timer.current); timer.current = null; engine.pause(); }
    }, 200);
    void engine.play(0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (e.key === ' ') { e.preventDefault(); engine.isPlaying() ? engine.pause() : void engine.play(0); }
      if (e.key === 'Enter' || e.key === '+') { e.preventDefault(); setCount((c) => c + 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const showA = Math.floor(pos.beat / beatsEach) % 2 === 0;
  const beatInChord = Math.floor(pos.beat) % beatsEach;

  return (
    <div className="page drill">
      <header className="page-head">
        <h1><a href="#/" className="btn ghost">←</a> Chord change drill</h1>
        <div className="actions">
          {PRESETS.map(([x, y]) => (
            <button key={x + y} className="btn ghost small" onClick={() => { setA(x); setB(y); }}>{x}↔{y}</button>
          ))}
        </div>
      </header>

      <div className="drill-stage">
        {[ra, rb].map((r, i) => {
          const active = pos.playing ? (i === 0) === showA : false;
          return (
            <div key={i} className={`drill-chord${active ? ' active' : ''}`}>
              <div className="chord-name">{r.display}</div>
              <ChordDiagram voicing={r.voicing} name={r.display} size={300} />
              {r.note && <div className="chord-note">easy: {r.note}</div>}
              {active && (
                <div className="drill-beats">
                  {Array.from({ length: beatsEach }, (_, k) => <span key={k} className={k === beatInChord ? 'on' : ''} />)}
                </div>
              )}
            </div>
          );
        })}
        <div className="drill-score">
          <div className="big">{count}</div>
          <div className="muted">clean changes</div>
          {timeLeft !== null && <div className="timer">{timeLeft}s</div>}
          <button className="btn primary" onClick={() => setCount((c) => c + 1)}>+1 <kbd>Enter</kbd></button>
        </div>
      </div>

      <footer className="transport">
        <div className="group">
          <button className="btn primary play" onClick={() => (engine.isPlaying() ? engine.pause() : void engine.play(0))} disabled={!valid}>
            {pos.playing ? '❚❚' : '▶'}
          </button>
          <button className="btn" onClick={startMinute} disabled={!valid}>⏱ One-minute changes</button>
        </div>
        <div className="group">
          <label className="field inline"><span>Chord A</span><input value={a} onChange={(e) => setA(e.target.value.trim())} size={6} /></label>
          <label className="field inline"><span>Chord B</span><input value={b} onChange={(e) => setB(e.target.value.trim())} size={6} /></label>
        </div>
        <div className="group">
          <label className="field inline">
            <span>Tempo {bpm}</span>
            <input type="range" min={30} max={140} step={5} value={bpm} onChange={(e) => setBpm(Number(e.target.value))} />
          </label>
          <label className="field inline">
            <span>Switch every</span>
            <select value={beatsEach} onChange={(e) => setBeatsEach(Number(e.target.value))}>
              <option value={8}>2 bars</option>
              <option value={4}>bar</option>
              <option value={2}>2 beats</option>
              <option value={1}>beat</option>
            </select>
          </label>
        </div>
      </footer>
      {pos.countIn > 0 && <div className="countin">{pos.countIn}</div>}
    </div>
  );
}
