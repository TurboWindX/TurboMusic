import { useSettings } from '../state/settings';

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const slider = (label: string, key: 'volMelody' | 'volChords' | 'volClick', max = 1) => (
    <label className="field">
      <span>{label}</span>
      <input type="range" min={0} max={max} step={0.05} value={s[key]} onChange={(e) => s.set({ [key]: Number(e.target.value) })} />
    </label>
  );
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <div className="form-grid">
          <label className="field">
            <span>Chord player name</span>
            <input value={s.chordPlayerName} onChange={(e) => s.set({ chordPlayerName: e.target.value })} />
          </label>
          <label className="field">
            <span>Melody player name</span>
            <input value={s.melodyPlayerName} onChange={(e) => s.set({ melodyPlayerName: e.target.value })} />
          </label>
          {slider('Melody synth volume', 'volMelody')}
          {slider('Chord synth volume', 'volChords')}
          {slider('Metronome volume', 'volClick')}
          <label className="field">
            <span>Tab size ({s.tabSize}px between strings)</span>
            <input type="range" min={30} max={80} step={2} value={s.tabSize} onChange={(e) => s.set({ tabSize: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Tab zoom ({s.zoom}px / beat)</span>
            <input type="range" min={50} max={220} step={10} value={s.zoom} onChange={(e) => s.set({ zoom: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>A/V offset ({s.latencyMs} ms) — raise if the screen runs ahead of the sound</span>
            <input type="range" min={-200} max={300} step={10} value={s.latencyMs} onChange={(e) => s.set({ latencyMs: Number(e.target.value) })} />
          </label>
          <label className="field check">
            <input type="checkbox" checked={s.countIn} onChange={(e) => s.set({ countIn: e.target.checked })} />
            <span>Count-in bar before playing</span>
          </label>
        </div>
        <h3>Piano / MIDI keyboard</h3>
        <div className="form-grid">
          <label className="field">
            <span>Easy piano chords</span>
            <select value={s.pianoEasyChords} onChange={(e) => s.set({ pianoEasyChords: e.target.value as typeof s.pianoEasyChords })}>
              <option value="triad">simple 3-note chords</option>
              <option value="root">just the root note (easiest)</option>
            </select>
          </label>
          <label className="field">
            <span>Falling notes speed ({s.pianoZoom}px / beat)</span>
            <input type="range" min={60} max={240} step={10} value={s.pianoZoom} onChange={(e) => s.set({ pianoZoom: Number(e.target.value) })} />
          </label>
          <label className="field check">
            <input type="checkbox" checked={s.pianoAnyOctave} onChange={(e) => s.set({ pianoAnyOctave: e.target.checked })} />
            <span>Right note in any octave counts (handy on small keyboards)</span>
          </label>
          <label className="field check">
            <input type="checkbox" checked={s.midiSound} onChange={(e) => s.set({ midiSound: e.target.checked })} />
            <span>Play a sound for my keys (turn off if your keyboard has its own speakers)</span>
          </label>
          <label className="field">
            <span>Key sound volume</span>
            <input type="range" min={0} max={1} step={0.05} value={s.volKeys} onChange={(e) => s.set({ volKeys: Number(e.target.value) })} />
          </label>
        </div>
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
