import { useEffect, useRef, useState } from 'react';
import { engine, type Position } from '../audio/engine';

/** Calls cb every animation frame with the engine position. */
export function useFrame(cb: (pos: Position) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    let id = 0;
    const loop = () => {
      ref.current(engine.getPosition());
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
}

/**
 * React state that only changes when the playhead crosses a grid step
 * (e.g. step=0.5 -> re-render on every 8th note), to keep renders cheap.
 */
export function useQuantizedPosition(step = 0.5) {
  const [state, setState] = useState<{ slot: number; playing: boolean; countIn: number }>({
    slot: 0, playing: false, countIn: 0,
  });
  const last = useRef(state);
  useFrame((p) => {
    const slot = Math.floor(p.beat / step + 1e-6);
    const s = last.current;
    if (slot !== s.slot || p.playing !== s.playing || p.countIn !== s.countIn) {
      last.current = { slot, playing: p.playing, countIn: p.countIn };
      setState(last.current);
    }
  });
  return { beat: state.slot * step, playing: state.playing, countIn: state.countIn };
}
