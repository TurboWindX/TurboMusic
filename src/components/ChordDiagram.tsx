import { memo } from 'react';
import type { Voicing } from '../music/chords';

export const FINGER_COLORS = ['', '#5fb3ff', '#7bd88f', '#ffb454', '#ff7eb6'];

interface Props {
  voicing: Voicing | null;
  name: string;
  /** Rendered width in px; height follows. */
  size?: number;
  showFingers?: boolean;
  dim?: boolean;
}

/** Vertical chord box: strings low E (left) -> high e (right). */
export const ChordDiagram = memo(function ChordDiagram({ voicing, name, size = 220, showFingers = true, dim }: Props) {
  // Wide left margin leaves room for the "9fr" position tag.
  const W = 250, H = 250;
  const padL = 76, padR = 28, top = 52, fretsShown = 5;
  const sw = (W - padL - padR) / 5;
  const fh = (H - top - 18) / fretsShown;

  if (!voicing) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width={size} className="chord-diagram" aria-label={name}>
        <text x={W / 2} y={H / 2} textAnchor="middle" className="cd-unknown">?</text>
        <text x={W / 2} y={H / 2 + 30} textAnchor="middle" className="cd-sub">no shape for {name}</text>
      </svg>
    );
  }

  const fretted = voicing.frets.filter((f): f is number => f !== null && f > 0);
  const maxF = fretted.length ? Math.max(...fretted) : 0;
  const minF = fretted.length ? Math.min(...fretted) : 0;
  const base = maxF <= fretsShown ? 1 : minF;
  const x = (s: number) => padL + s * sw;
  const y = (fret: number) => top + (fret - base + 0.5) * fh;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={size} className={`chord-diagram${dim ? ' dim' : ''}`} aria-label={`${name} chord`}>
      {/* nut or base fret label */}
      {base === 1 ? (
        <rect x={padL - 2} y={top - 6} width={W - padL - padR + 4} height={7} rx={2} className="cd-nut" />
      ) : (
        <g aria-label={`starts at fret ${base}`}>
          <rect x={4} y={top + fh * 0.5 - 17} width={padL - 22} height={34} rx={8} className="cd-basefret-bg" />
          <text x={4 + (padL - 22) / 2} y={top + fh * 0.5 + 8} textAnchor="middle" className="cd-basefret">{base}fr</text>
        </g>
      )}
      {/* frets */}
      {Array.from({ length: fretsShown + 1 }, (_, i) => (
        <line key={`f${i}`} x1={padL} x2={W - padR} y1={top + i * fh} y2={top + i * fh} className="cd-fret" />
      ))}
      {/* strings (thicker = lower) */}
      {Array.from({ length: 6 }, (_, s) => (
        <line key={`s${s}`} x1={x(s)} x2={x(s)} y1={top} y2={top + fretsShown * fh} className="cd-string" strokeWidth={2.6 - s * 0.3} />
      ))}
      {/* open / muted markers */}
      {voicing.frets.map((f, s) =>
        f === null ? (
          <text key={`m${s}`} x={x(s)} y={top - 16} textAnchor="middle" className="cd-mute">×</text>
        ) : f === 0 ? (
          <circle key={`o${s}`} cx={x(s)} cy={top - 22} r={7} className="cd-open" />
        ) : null,
      )}
      {/* barre */}
      {voicing.barre && (
        <rect
          x={x(voicing.barre.from) - 11}
          y={y(voicing.barre.fret) - 11}
          width={x(voicing.barre.to) - x(voicing.barre.from) + 22}
          height={22}
          rx={11}
          fill={FINGER_COLORS[1]}
          className="cd-barre"
        />
      )}
      {/* dots */}
      {voicing.frets.map((f, s) => {
        if (!f) return null;
        const finger = voicing.fingers[s];
        const inBarre = voicing.barre && finger === 1 && f === voicing.barre.fret;
        return (
          <g key={`d${s}`}>
            {!inBarre && <circle cx={x(s)} cy={y(f)} r={13} fill={FINGER_COLORS[finger] || '#e6e6e6'} className="cd-dot" />}
            {showFingers && finger > 0 && (
              <text x={x(s)} y={y(f) + 6} textAnchor="middle" className="cd-finger">{finger}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
});
