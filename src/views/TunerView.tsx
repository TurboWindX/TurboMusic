import { useEffect, useRef, useState } from 'react';
import { Tuner } from '../audio/tuner';
import { STANDARD_TUNING, midiName } from '../music/theory';

interface Reading { note: string; cents: number; freq: number; string: number }

export function TunerView() {
  const tuner = useRef<Tuner | null>(null);
  const [on, setOn] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const smooth = useRef<number | null>(null);

  useEffect(() => () => tuner.current?.stop(), []);

  useEffect(() => {
    if (!on) return;
    let id = 0;
    let lastHeard = 0;
    const loop = () => {
      const r = tuner.current?.read();
      const now = performance.now();
      if (r && r.clarity > 0.8 && r.freq > 60 && r.freq < 1200) {
        const midiF = 69 + 12 * Math.log2(r.freq / 440);
        smooth.current = smooth.current === null || Math.abs(smooth.current - midiF) > 0.7 ? midiF : smooth.current * 0.8 + midiF * 0.2;
        const m = smooth.current;
        const nearest = Math.round(m);
        // Nearest open string, for the "which string" hint.
        let string = 0;
        STANDARD_TUNING.forEach((s, i) => { if (Math.abs(s - m) < Math.abs(STANDARD_TUNING[string] - m)) string = i; });
        setReading({ note: midiName(nearest), cents: Math.round((m - nearest) * 100), freq: r.freq, string });
        lastHeard = now;
      } else if (now - lastHeard > 1500) {
        smooth.current = null;
        setReading(null);
      }
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [on]);

  const start = async () => {
    try {
      tuner.current = new Tuner();
      await tuner.current.start();
      setOn(true);
      setErr(null);
    } catch (e) {
      setErr(window.isSecureContext
        ? `Microphone unavailable: ${(e as Error).message}`
        : 'Microphone needs localhost or HTTPS. Open the app via http://localhost or a tunnel URL.');
    }
  };

  const inTune = reading && Math.abs(reading.cents) <= 5;
  const target = reading ? STANDARD_TUNING[reading.string] : null;

  return (
    <div className="page tuner">
      <header className="page-head">
        <h1><a href="#/" className="btn ghost">←</a> Tuner</h1>
      </header>
      {!on ? (
        <div className="center-msg">
          <button className="btn primary big" onClick={start}>🎤 Start tuner</button>
          {err && <p className="banner error">{err}</p>}
        </div>
      ) : (
        <div className="tuner-stage">
          <div className={`tuner-note${inTune ? ' in' : ''}`}>{reading?.note ?? '—'}</div>
          <div className="tuner-meter">
            <div className="tuner-scale">
              {[-50, -25, 0, 25, 50].map((c) => <span key={c} style={{ left: `${50 + c}%` }}>{c > 0 ? `+${c}` : c}</span>)}
            </div>
            <div className="tuner-needle" style={{ left: `${50 + Math.max(-50, Math.min(50, reading?.cents ?? 0))}%`, opacity: reading ? 1 : 0.2 }} />
          </div>
          <div className="tuner-hint">
            {reading ? (inTune ? 'in tune ✓' : reading.cents < 0 ? 'too low — tighten ↑' : 'too high — loosen ↓') : 'play one string'}
          </div>
          <div className="tuner-strings">
            {STANDARD_TUNING.map((m, i) => (
              <span key={i} className={target === m ? 'on' : ''}>{midiName(m)}</span>
            ))}
          </div>
          {reading && <div className="muted">{reading.freq.toFixed(1)} Hz</div>}
        </div>
      )}
    </div>
  );
}
