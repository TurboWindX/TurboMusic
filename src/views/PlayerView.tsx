import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Song } from '../../shared/types';
import { api } from '../api';
import { engine } from '../audio/engine';
import { buildArrangement, buildStrums, sectionAt, type StrumMode } from '../music/arrangement';
import { recommendCapo, resolveChord, type ResolvedChord } from '../music/chords';
import { STANDARD_TUNING } from '../music/theory';
import { transposeMelody } from '../music/refret';
import { useSettings } from '../state/settings';
import { go } from '../router';
import { ChordLane } from '../components/ChordLane';
import { Timeline } from '../components/Timeline';
import { useQuantizedPosition } from '../components/hooks';
import { SettingsPanel } from '../components/SettingsPanel';
import { ChordSheet } from '../components/ChordSheet';
import { isTyping } from '../components/keys';

const STRUM_LABEL: Record<StrumMode, string> = { once: 'Once / chord', beats: 'Every beat', pattern: 'Song pattern' };
const STRUM_ORDER: StrumMode[] = ['once', 'beats', 'pattern'];

export function PlayerView({ id }: { id: string }) {
  const [song, setSong] = useState<Song | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSong(null);
    api.get(id).then(setSong).catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  if (error) return <div className="center-msg">Couldn’t load song: {error} <a href="#/">Back</a></div>;
  if (!song) return <div className="center-msg">Loading…</div>;
  return <Player song={song} />;
}

function Player({ song }: { song: Song }) {
  const s = useSettings();
  const [loop, setLoop] = useState<{ start: number; end: number } | null>(null);
  const [pendingA, setPendingA] = useState<number | null>(null);
  const [panel, setPanel] = useState<null | 'settings' | 'help' | 'chords'>(null);
  const pos = useQuantizedPosition(0.5);

  const noCapo = !s.haveCapo;
  const baseArr = useMemo(() => buildArrangement(song), [song]);
  /** Capo (or downward shift) that makes the chord shapes clearly easier, if any. */
  const capoAdvice = useMemo(() => recommendCapo(baseArr.chords.map((c) => c.chord)), [baseArr]);
  /** A manual choice wins; otherwise easy mode applies the recommended capo automatically. */
  const manualCapo: number | undefined = s.chordCapos[song.id];
  const autoCapo = s.easyChords ? (capoAdvice?.capo ?? 0) : 0;
  const chordCapo = manualCapo ?? autoCapo;
  /** Without a capo the whole song moves down by the chord capo amount, so the chord shapes stay the same. */
  const arr = useMemo(
    () => (noCapo && chordCapo ? { ...baseArr, melody: transposeMelody(baseArr.melody, -chordCapo) } : baseArr),
    [baseArr, noCapo, chordCapo],
  );
  const bpb = arr.beatsPerBar;

  const resolved = useMemo(() => {
    const m = new Map<string, ResolvedChord>();
    arr.uniqueChords.forEach((c) => m.set(c, resolveChord(c, { easy: s.easyChords, shift: chordCapo })));
    return m;
  }, [arr, s.easyChords, chordCapo]);
  const chordLabel = useCallback((c: string) => resolved.get(c)?.display ?? c, [resolved]);

  const strums = useMemo(() => buildStrums(arr, s.strumMode, song.strumPattern), [arr, s.strumMode, song.strumPattern]);

  // --- feed the engine
  useEffect(() => {
    engine.load({
      melody: arr.melody.map((n) => ({ beat: n.beat, midi: STANDARD_TUNING[n.string] + n.fret })),
      strums: strums.map((st) => ({
        beat: st.beat,
        dir: st.dir,
        midi: (resolved.get(st.chord)?.midi ?? []).map((m) => m + (noCapo ? 0 : chordCapo)),
      })),
      beatsPerBar: bpb,
      totalBeats: arr.totalBeats,
      bpm: song.bpm,
      capo: noCapo ? 0 : song.capo,
    });
  }, [arr, strums, resolved, chordCapo, noCapo, song.bpm, song.capo, bpb]);

  useEffect(() => { engine.setSpeed(s.speed); }, [s.speed]);
  useEffect(() => {
    engine.metronome = s.metronome;
    engine.countInEnabled = s.countIn;
    engine.latencyMs = s.latencyMs;
    engine.setMuted('melody', s.muteMelody);
    engine.setMuted('chords', s.muteChords);
    engine.setVolume('melody', s.volMelody);
    engine.setVolume('chords', s.volChords);
    engine.setVolume('click', s.volClick);
  }, [s.metronome, s.countIn, s.latencyMs, s.muteMelody, s.muteChords, s.volMelody, s.volChords, s.volClick]);
  useEffect(() => { engine.loop = loop; }, [loop]);
  useEffect(() => {
    engine.stop();
    engine.seek(0);
    return () => engine.stop();
  }, [song.id]);

  // --- actions
  const bar = Math.min(arr.totalBars - 1, Math.floor(pos.beat / bpb));
  const section = sectionAt(arr, bar);
  /** Bar under the playhead right now (React state can lag behind fast key presses). */
  const liveBar = useCallback(
    () => Math.max(0, Math.min(arr.totalBars - 1, Math.floor(engine.getPosition().beat / bpb + 1e-6))),
    [arr, bpb],
  );
  const pendingARef = useRef<number | null>(null);

  const toggle = useCallback(() => {
    if (engine.isPlaying()) engine.pause();
    else void engine.play();
  }, []);
  const seekBar = useCallback((b: number) => engine.seek(Math.max(0, Math.min(arr.totalBars - 1, b)) * bpb), [arr, bpb]);
  const restart = useCallback(() => engine.seek(loop ? loop.start : 0), [loop]);
  const loopSection = useCallback(() => {
    if (loop) { setLoop(null); return; }
    const secs = arr.sections;
    const b = liveBar();
    const cur = sectionAt(arr, b);
    let startBar: number, endBar: number;
    if (cur) {
      const idx = secs.indexOf(cur);
      startBar = cur.startBar;
      endBar = secs[idx + 1]?.startBar ?? arr.totalBars;
    } else {
      startBar = Math.floor(b / 4) * 4;
      endBar = Math.min(arr.totalBars, startBar + 4);
    }
    setLoop({ start: startBar * bpb, end: endBar * bpb });
  }, [loop, arr, bpb, liveBar]);
  const markA = useCallback(() => {
    pendingARef.current = liveBar();
    setPendingA(pendingARef.current);
    setLoop(null);
  }, [liveBar]);
  const markB = useCallback(() => {
    const b = liveBar();
    const a = pendingARef.current ?? b;
    setLoop({ start: Math.min(a, b) * bpb, end: (Math.max(a, b) + 1) * bpb });
    pendingARef.current = null;
    setPendingA(null);
  }, [liveBar, bpb]);
  const nudgeSpeed = useCallback((d: number) => {
    const v = Math.round((useSettings.getState().speed + d) * 100) / 100;
    s.set({ speed: Math.max(0.4, Math.min(1.2, v)) });
  }, [s]);
  const cycleStrum = () => s.set({ strumMode: STRUM_ORDER[(STRUM_ORDER.indexOf(s.strumMode) + 1) % 3] });
  const setChordCapo = (c: number | 'auto') => {
    const next = { ...s.chordCapos };
    if (c === 'auto') delete next[song.id];
    else next[song.id] = c;
    s.set({ chordCapos: next });
  };
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  };

  // --- keyboard / TV remote
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const k = e.key;
      if (k === ' ' || k === 'MediaPlayPause' || k === 'k') toggle();
      else if (k === 'ArrowRight') e.shiftKey ? jumpSection(1) : seekBar(liveBar() + 1);
      else if (k === 'ArrowLeft') e.shiftKey ? jumpSection(-1) : seekBar(liveBar() - 1);
      else if (k === 'ArrowUp') nudgeSpeed(0.05);
      else if (k === 'ArrowDown') nudgeSpeed(-0.05);
      else if (k === 'Home' || k === '0') restart();
      else if (k === 'l' || k === 'L') loopSection();
      else if (k === '[') markA();
      else if (k === ']') markB();
      else if (k === 'm' || k === 'M') s.set({ metronome: !s.metronome });
      else if (k === 'e' || k === 'E') s.set({ easyChords: !s.easyChords });
      else if (k === 's' || k === 'S') cycleStrum();
      else if (k === '1') s.set({ muteChords: !s.muteChords });
      else if (k === '2') s.set({ muteMelody: !s.muteMelody });
      else if (k === 'f' || k === 'F') fullscreen();
      else if (k === 'c' || k === 'C') setPanel((p) => (p === 'chords' ? null : 'chords'));
      else if (k === '?' || k === 'h') setPanel((p) => (p === 'help' ? null : 'help'));
      else if (k === 'Escape') setPanel(null);
      else return;
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur?.();
    };
    const jumpSection = (dir: number) => {
      const secs = arr.sections;
      const b = liveBar();
      if (!secs.length) return seekBar(b + dir * 4);
      const cur = sectionAt(arr, b);
      const idx = cur ? secs.indexOf(cur) : -1;
      const target = secs[Math.max(0, Math.min(secs.length - 1, idx + dir))];
      seekBar(target.startBar);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const herCapo = song.capo + chordCapo;
  const herCapoLabel = noCapo ? (herCapo > 0 ? 'no capo needed' : null) : herCapo > 0 ? `capo on fret ${herCapo}` : null;
  const tempo = Math.round(song.bpm * s.speed);

  return (
    <div className="player">
      <header className="player-head">
        <button className="btn ghost" onClick={() => go({ name: 'library' })} title="Back to songs">←</button>
        <div className="song-title">
          <h1>{song.title}</h1>
          {song.artist && <span className="muted">{song.artist}</span>}
        </div>
        <nav className="section-chips">
          {arr.sections.map((sec, i) => (
            <button
              key={i}
              className={`chip${section === sec ? ' active' : ''}`}
              onClick={() => seekBar(sec.startBar)}
            >{sec.name}</button>
          ))}
        </nav>
        <div className="head-stats">
          <span className="stat"><b>{bar + 1}</b>/{arr.totalBars}<small>bar</small></span>
          <span className="stat"><b>{tempo}</b><small>bpm · {Math.round(s.speed * 100)}%</small></span>
        </div>
        <div className="head-tools">
          <button className="btn chords-btn" onClick={() => setPanel('chords')} title="All chords in this song (C)">🎸 chords</button>
          <button className="btn ghost" onClick={() => go({ name: 'drill', chords: arr.uniqueChords.slice(0, 2) })} title="Chord change drill">drill</button>
          <button className="btn ghost" onClick={() => go({ name: 'edit', id: song.id })}>edit</button>
          <button className="btn ghost" onClick={() => setPanel('settings')} title="Settings">⚙</button>
          <button className="btn ghost" onClick={() => setPanel('help')} title="Keys (?)">?</button>
          <button className="btn ghost" onClick={fullscreen} title="Fullscreen (F)">⛶</button>
        </div>
      </header>

      <ChordLane
        arr={arr}
        resolved={resolved}
        strums={strums}
        beat={pos.beat}
        playing={pos.playing}
        playerName={s.chordPlayerName}
        capoLabel={herCapoLabel}
      />

      <section className="lane melody-lane">
        <header className="lane-head">
          <span className="lane-who melody">{s.melodyPlayerName}</span>
          <span className="lane-what">melody</span>
          {!noCapo && song.capo > 0 && <span className="pill">capo on fret {song.capo}</span>}
          {noCapo && herCapo > 0 && <span className="pill">no capo · song moved down {herCapo} so the shapes stay easy</span>}
          {arr.melody.length === 0 && <span className="muted">no tab yet — add one in the editor</span>}
        </header>
        <Timeline
          arr={arr}
          chordLabel={chordLabel}
          zoom={s.zoom}
          stringGap={s.tabSize}
          live
          loop={loop}
          onSeek={(b) => engine.seek(b)}
        />
      </section>

      <footer className="transport">
        <div className="group">
          <button className="btn" onClick={restart} title="Restart (Home)">⏮</button>
          <button className="btn primary play" onClick={toggle} title="Play / pause (Space)">
            {pos.playing ? '❚❚' : '▶'}
          </button>
        </div>
        <div className="group">
          <button className="btn" onClick={() => nudgeSpeed(-0.05)} title="Slower (↓)">−</button>
          <input
            type="range" min={0.4} max={1.2} step={0.05} value={s.speed}
            onChange={(e) => s.set({ speed: Number(e.target.value) })}
            aria-label="speed"
          />
          <button className="btn" onClick={() => nudgeSpeed(0.05)} title="Faster (↑)">+</button>
          <span className="speed-label">{Math.round(s.speed * 100)}%</span>
        </div>
        <div className="group">
          <button className={`btn${loop ? ' on' : ''}`} onClick={loopSection} title="Loop section (L)">
            ⟳ {loop ? `bars ${loop.start / bpb + 1}–${loop.end / bpb}` : 'Loop'}
          </button>
          <button className={`btn${pendingA !== null ? ' on' : ''}`} onClick={markA} title="Loop start = this bar ([)">A</button>
          <button className="btn" onClick={markB} title="Loop end = this bar (])">B</button>
        </div>
        <div className="group">
          <button className={`btn${s.metronome ? ' on' : ''}`} onClick={() => s.set({ metronome: !s.metronome })} title="Metronome (M)">♩ click</button>
          <button className={`btn${s.easyChords ? ' on' : ''}`} onClick={() => s.set({ easyChords: !s.easyChords })} title="Easy chord shapes (E)">easy</button>
          <button className="btn" onClick={cycleStrum} title="Strum mode (S)">↓ {STRUM_LABEL[s.strumMode]}</button>
          <button className={`btn${s.muteChords ? ' off' : ''}`} onClick={() => s.set({ muteChords: !s.muteChords })} title="Mute chord synth (1)">
            {s.muteChords ? '🔇' : '🔊'} chords
          </button>
          <button className={`btn${s.muteMelody ? ' off' : ''}`} onClick={() => s.set({ muteMelody: !s.muteMelody })} title="Mute melody synth (2)">
            {s.muteMelody ? '🔇' : '🔊'} melody
          </button>
        </div>
        <div className="group">
          <label className="capo-select" title="No capo at home? Untick it: the whole song moves down instead and the chord shapes stay the same">
            <input type="checkbox" checked={s.haveCapo} onChange={(e) => s.set({ haveCapo: e.target.checked })} />
            we have a capo
          </label>
          <label className="capo-select" title="Auto: easy mode picks the capo that gives the easiest chord shapes">
            {noCapo ? 'move song down' : 'chord capo'}
            <select
              value={manualCapo ?? 'auto'}
              onChange={(e) => setChordCapo(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
            >
              <option value="auto">auto ({autoCapo})</option>
              {Array.from({ length: 8 }, (_, i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </label>
        </div>
      </footer>

      {pos.countIn > 0 && <div className="countin">{pos.countIn}</div>}
      {panel === 'settings' && <SettingsPanel onClose={() => setPanel(null)} />}
      {panel === 'help' && <HelpPanel onClose={() => setPanel(null)} />}
      {panel === 'chords' && <ChordSheet arr={arr} resolved={resolved} capoLabel={herCapoLabel} onClose={() => setPanel(null)} />}
    </div>
  );
}

function HelpPanel({ onClose }: { onClose: () => void }) {
  const keys: [string, string][] = [
    ['Space', 'play / pause'], ['← →', 'previous / next bar'], ['Shift + ← →', 'previous / next section'],
    ['↑ ↓', 'speed ±5%'], ['Home / 0', 'back to start (or loop start)'], ['L', 'loop current section'],
    ['[  ]', 'loop from bar A to bar B'], ['C', 'all chords in this song'], ['M', 'metronome'], ['E', 'easy chord shapes'], ['S', 'strum mode'],
    ['1 / 2', 'mute chord / melody synth'], ['F', 'fullscreen'], ['Esc', 'close panel'],
  ];
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard / remote</h2>
        <table className="keys"><tbody>
          {keys.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}
        </tbody></table>
        <p className="muted">Click a bar in the tab to jump there.</p>
        <button className="btn primary" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
