/** Per-player switches in a lane header: instrument (guitar / piano) and level (easy / original). */
import { partKeys, useSettings, type Instrument, type Level, type Role } from '../state/settings';

const LEVEL_HELP: Record<Role, Record<Instrument, Record<Level, string>>> = {
  rhythm: {
    guitar: { easy: 'Simplified open-chord shapes, with a capo when that makes them easier', original: 'The chords exactly as written' },
    piano: { easy: 'Simple chords in one hand position', original: 'The left hand as written in the sheet music, or full chords' },
  },
  lead: {
    guitar: { easy: 'The simplified melody tab', original: 'The full tab as imported' },
    piano: { easy: 'Melody only, one note at a time', original: 'The right hand as written, all notes' },
  },
};

export function PartControls({ role, sameNote }: { role: Role; sameNote?: boolean }) {
  const s = useSettings();
  const k = partKeys[role];
  const instrument = s[k.instrument];
  const level = s[k.level];
  return (
    <span className="part-controls">
      <span className="seg" role="group" aria-label="instrument">
        {(['guitar', 'piano'] as Instrument[]).map((i) => (
          <button
            key={i}
            className={`seg-btn${instrument === i ? ' active' : ''}`}
            onClick={() => s.set({ [k.instrument]: i })}
            title={i === 'guitar' ? 'Play this part on guitar' : 'Play this part on piano / keyboard'}
          >{i === 'guitar' ? '🎸 guitar' : '🎹 piano'}</button>
        ))}
      </span>
      <span className="seg" role="group" aria-label="level">
        {(['easy', 'original'] as Level[]).map((l) => (
          <button
            key={l}
            className={`seg-btn${level === l ? ' active' : ''}`}
            onClick={() => s.set({ [k.level]: l })}
            title={LEVEL_HELP[role][instrument][l] + (l === 'original' && sameNote ? ' (this song has no separate original, so it is the same)' : '')}
          >{l}</button>
        ))}
      </span>
    </span>
  );
}
