import { useMemo } from 'react';
import { chordAt, type Arrangement, type StrumEvent } from '../music/arrangement';
import type { ResolvedChord } from '../music/chords';
import { ChordDiagram } from './ChordDiagram';

interface Props {
  arr: Arrangement;
  resolved: Map<string, ResolvedChord>;
  strums: StrumEvent[];
  beat: number; // quantised to 8ths
  playing: boolean;
  playerName: string;
  capoLabel: string | null;
}

export function ChordLane({ arr, resolved, strums, beat, playing, playerName, capoLabel }: Props) {
  const bpb = arr.beatsPerBar;
  const { index, event } = chordAt(arr, beat);
  const next = arr.chords[index + 1] ?? null;
  const cur = event ? resolved.get(event.chord) : null;
  const nxt = next ? resolved.get(next.chord) : null;
  const beatsToNext = next ? next.beat - beat : null;
  const bar = Math.floor(beat / bpb);

  const strumSet = useMemo(() => {
    const m = new Map<number, 'D' | 'U'>();
    strums.forEach((s) => m.set(Math.round(s.beat * 2), s.dir));
    return m;
  }, [strums]);

  const slots = Array.from({ length: bpb * 2 }, (_, i) => {
    const b2 = bar * bpb * 2 + i;
    return { dir: strumSet.get(b2) ?? null, current: playing && Math.round(beat * 2) === b2, label: i % 2 === 0 ? String(i / 2 + 1) : '&' };
  });

  const soon = beatsToNext !== null && beatsToNext <= 2 && playing;

  return (
    <section className="lane chord-lane">
      <header className="lane-head">
        <span className="lane-who chords">{playerName}</span>
        <span className="lane-what">chords</span>
        {capoLabel && <span className="pill">{capoLabel}</span>}
        <span className="chord-legend" aria-label="How to read the chord diagrams">
          <span><i className="lg-open" /> play open</span>
          <span><i className="lg-mute">×</i> don't play</span>
          <span><i className="lg-dot">1</i> finger: 1 index · 2 middle · 3 ring · 4 pinky</span>
        </span>
      </header>
      <div className="chord-lane-body">
        <div className="chord-now">
          <ChordDiagram voicing={cur?.voicing ?? null} name={cur?.display ?? ''} size={260} />
          <div className="chord-now-text">
            <div className="chord-name">{cur?.display ?? '—'}</div>
            {cur?.note && <div className="chord-note">easy: {cur.note}</div>}
          </div>
        </div>

        <div className="chord-mid">
          <div className="strum-row" aria-label="strum pattern">
            {slots.map((s, i) => (
              <div key={i} className={`strum-slot${s.current ? ' current' : ''}${s.dir ? ' hit' : ''}${i % 2 === 0 ? ' downbeat' : ''}`}>
                <div className="strum-arrow">{s.dir === 'D' ? '↓' : s.dir === 'U' ? '↑' : '·'}</div>
                <div className="strum-count">{s.label}</div>
              </div>
            ))}
          </div>
          {next && (
            <div className={`change-cue${soon ? ' soon' : ''}`}>
              {soon ? (
                <>change in <b>{Math.ceil(beatsToNext!)}</b></>
              ) : (
                <>next change in {Math.ceil(beatsToNext!)} beats</>
              )}
            </div>
          )}
        </div>

        <div className={`chord-next${soon ? ' soon' : ''}`}>
          <div className="chord-next-text">
            <div className="chord-next-label">next</div>
            <div className="chord-name small">{nxt?.display ?? 'end'}</div>
            {nxt?.note && <div className="chord-note">easy: {nxt.note}</div>}
          </div>
          {nxt && <ChordDiagram voicing={nxt.voicing} name={nxt.display} size={220} />}
        </div>
      </div>
    </section>
  );
}
