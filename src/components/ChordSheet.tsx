/** "Chords to learn" sheet: every chord in the song, as it will be shown while playing. */
import { useMemo } from 'react';
import type { Arrangement } from '../music/arrangement';
import type { ResolvedChord } from '../music/chords';
import { go } from '../router';
import { ChordDiagram } from './ChordDiagram';

interface Props {
  arr: Arrangement;
  resolved: Map<string, ResolvedChord>;
  capoLabel: string | null;
  onClose: () => void;
}

function level(d: number): { label: string; cls: string } {
  if (d <= 4) return { label: 'easy', cls: 'lvl-easy' };
  if (d <= 6.5) return { label: 'medium', cls: 'lvl-medium' };
  return { label: 'hard', cls: 'lvl-hard' };
}

export function ChordSheet({ arr, resolved, capoLabel, onClose }: Props) {
  const { chords, changes, totalBeats } = useMemo(() => {
    // Group by the *displayed* shape: two source chords can become the same easy shape.
    const byShape = new Map<string, { r: ResolvedChord; beats: number; times: number; first: number }>();
    arr.chords.forEach((c, i) => {
      const r = resolved.get(c.chord);
      if (!r) return;
      const e = byShape.get(r.display) ?? { r, beats: 0, times: 0, first: i };
      e.beats += c.duration;
      e.times += 1;
      byShape.set(r.display, e);
    });
    const pairs = new Map<string, { a: string; b: string; n: number }>();
    for (let i = 1; i < arr.chords.length; i++) {
      const a = resolved.get(arr.chords[i - 1].chord)?.display;
      const b = resolved.get(arr.chords[i].chord)?.display;
      if (!a || !b || a === b) continue;
      const key = [a, b].sort().join('↔');
      const p = pairs.get(key) ?? { a, b, n: 0 };
      p.n += 1;
      pairs.set(key, p);
    }
    return {
      chords: [...byShape.values()].sort((x, y) => x.first - y.first),
      changes: [...pairs.values()].sort((x, y) => y.n - x.n).slice(0, 4),
      totalBeats: arr.chords.reduce((s, c) => s + c.duration, 0) || 1,
    };
  }, [arr, resolved]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel chord-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Chords to learn <span className="muted">· {chords.length} chords{capoLabel ? ` · ${capoLabel}` : ''}</span></h2>
          <button className="btn primary" onClick={onClose}>Close <kbd>C</kbd></button>
        </header>
        <p className="muted">In the order they first appear. Learn the ones used most first: the bar shows how much of the song each chord covers.</p>

        <div className="sheet-grid">
          {chords.map(({ r, times, beats }) => {
            const lv = level(r.difficulty);
            const pct = Math.round((beats / totalBeats) * 100);
            return (
              <figure key={r.display} className="sheet-card">
                <figcaption>
                  <span className="sheet-name">{r.display}</span>
                  <span className={`lvl ${lv.cls}`}>{lv.label}</span>
                </figcaption>
                <ChordDiagram voicing={r.voicing} name={r.display} size={210} />
                <div className="sheet-usage" title={`${times} times, ${pct}% of the song`}>
                  <div className="sheet-bar"><span style={{ width: `${Math.max(4, pct)}%` }} /></div>
                  <small>{times}× · {pct}% of the song</small>
                </div>
                {r.note && <small className="muted">easy: {r.note}</small>}
              </figure>
            );
          })}
        </div>

        {changes.length > 0 && (
          <>
            <h3>Practice the changes that come up most</h3>
            <div className="sheet-changes">
              {changes.map((p) => (
                <button key={`${p.a}-${p.b}`} className="btn" onClick={() => go({ name: 'drill', chords: [p.a, p.b] })}>
                  {p.a} ↔ {p.b} <small className="muted">{p.n}×</small> · drill ▶
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
