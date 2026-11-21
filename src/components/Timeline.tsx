import { memo, useMemo, useRef } from 'react';
import type { Arrangement } from '../music/arrangement';
import { useFrame } from './hooks';

interface Props {
  arr: Arrangement;
  /** chord source name -> displayed name (easy mode / capo). */
  chordLabel: (name: string) => string;
  zoom: number; // px per beat
  stringGap?: number;
  live: boolean; // scroll with the playhead
  loop?: { start: number; end: number } | null;
  onSeek?: (beat: number) => void;
  /** Fraction of the viewport where the playhead sits (live mode). */
  playheadAt?: number;
}

const SECTION_H = 26;
const CHORD_H = 44;
const GAP = 14;
const LEFT_PAD = 40;

export const Timeline = memo(function Timeline({
  arr, chordLabel, zoom, stringGap = 36, live, loop, onSeek, playheadAt = 0.22,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const noteEls = useRef<(SVGGElement | null)[]>([]);
  const chordEls = useRef<(SVGGElement | null)[]>([]);
  const noteOn = useRef<boolean[]>([]);
  const chordOn = useRef<number>(-1);

  const tabTop = SECTION_H + CHORD_H + GAP;
  const height = tabTop + stringGap * 6;
  const width = LEFT_PAD + arr.totalBeats * zoom + 400;
  const bx = (beat: number) => LEFT_PAD + beat * zoom;
  const sy = (string: number) => tabTop + (5 - string + 0.5) * stringGap;

  useFrame((pos) => {
    const beat = pos.beat;
    if (live && strip.current && viewport.current) {
      const vw = viewport.current.clientWidth;
      strip.current.style.transform = `translate3d(${vw * playheadAt - bx(beat)}px,0,0)`;
    }
    // Light up sounding notes.
    const notes = arr.melody;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const on = pos.playing && !pos.countIn && beat >= n.beat - 0.02 && beat < n.beat + Math.min(n.duration, 1);
      if (on !== !!noteOn.current[i]) {
        noteOn.current[i] = on;
        noteEls.current[i]?.classList.toggle('on', on);
      }
    }
    let ci = -1;
    for (let i = 0; i < arr.chords.length; i++) {
      const c = arr.chords[i];
      if (beat >= c.beat && beat < c.beat + c.duration) { ci = i; break; }
    }
    if (ci !== chordOn.current) {
      chordEls.current[chordOn.current]?.classList.remove('on');
      chordEls.current[ci]?.classList.add('on');
      chordOn.current = ci;
    }
  });

  const handleClick = (e: React.MouseEvent) => {
    if (!onSeek || !strip.current) return;
    const rect = strip.current.getBoundingClientRect();
    const beat = (e.clientX - rect.left - LEFT_PAD) / zoom;
    const bar = Math.max(0, Math.floor(beat / arr.beatsPerBar));
    onSeek(bar * arr.beatsPerBar);
  };

  const svg = useMemo(() => {
    noteEls.current = [];
    chordEls.current = [];
    noteOn.current = [];
    chordOn.current = -1;
    const bpb = arr.beatsPerBar;
    return (
      <svg width={width} height={height} className="timeline-svg">
        {/* beat grid */}
        {Array.from({ length: arr.totalBeats + 1 }, (_, b) => (
          <line
            key={`b${b}`}
            x1={bx(b)} x2={bx(b)}
            y1={b % bpb === 0 ? SECTION_H : tabTop}
            y2={height}
            className={b % bpb === 0 ? 'tl-bar' : 'tl-beat'}
          />
        ))}
        {/* bar numbers */}
        {Array.from({ length: arr.totalBars }, (_, bar) => (
          <text key={`n${bar}`} x={bx(bar * bpb) + 5} y={tabTop - 3} className="tl-barnum">{bar + 1}</text>
        ))}
        {/* sections */}
        {arr.sections.map((s, i) => (
          <text key={`sec${i}`} x={bx(s.startBar * bpb) + 6} y={SECTION_H - 8} className="tl-section">{s.name}</text>
        ))}
        {/* chord strip */}
        {arr.chords.map((c, i) => (
          <g key={`c${i}`} ref={(el) => { chordEls.current[i] = el; }} className="tl-chord">
            <rect x={bx(c.beat) + 2} y={SECTION_H} width={c.duration * zoom - 4} height={CHORD_H - 6} rx={8} />
            <text x={bx(c.beat) + 12} y={SECTION_H + CHORD_H / 2 + 4}>{chordLabel(c.chord)}</text>
          </g>
        ))}
        {/* strings */}
        {Array.from({ length: 6 }, (_, s) => (
          <line key={`s${s}`} x1={0} x2={width} y1={sy(s)} y2={sy(s)} className="tl-string" />
        ))}
        {['E', 'A', 'D', 'G', 'B', 'e'].map((l, s) => (
          <text key={`l${s}`} x={8} y={sy(s) + stringGap * 0.16} className="tl-strlabel" style={{ fontSize: Math.max(14, stringGap * 0.42) }}>{l}</text>
        ))}
        {/* notes */}
        {arr.melody.map((n, i) => (
          <g key={`m${i}`} ref={(el) => { noteEls.current[i] = el; }} className="tl-note">
            <rect
              x={bx(n.beat)}
              y={sy(n.string) - 3}
              width={Math.max(0, Math.min(n.duration, 2) * zoom - 6)}
              height={6}
              rx={3}
              className="tl-sustain"
            />
            <circle cx={bx(n.beat)} cy={sy(n.string)} r={stringGap * 0.46} />
            <text x={bx(n.beat)} y={sy(n.string) + stringGap * 0.22} style={{ fontSize: Math.max(12, stringGap * 0.6) }}>{n.fret}</text>
            {n.technique && (
              <text x={bx(n.beat) + stringGap * 0.5} y={sy(n.string) - stringGap * 0.35} className="tl-tech">{n.technique}</text>
            )}
          </g>
        ))}
      </svg>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arr, zoom, stringGap, chordLabel]);

  return (
    <div className={`timeline${live ? ' live' : ''}`} ref={viewport} style={{ height }}>
      <div className="timeline-strip" ref={strip} onClick={handleClick}>
        {loop && (
          <div className="tl-loop" style={{ left: bx(loop.start), width: (loop.end - loop.start) * zoom, top: SECTION_H }} />
        )}
        {svg}
      </div>
      {live && <div className="tl-playhead" style={{ left: `${playheadAt * 100}%` }} />}
    </div>
  );
});
