/** Player preferences, persisted to localStorage (per device). */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { StrumMode } from '../music/arrangement';
import type { PracticeMode } from '../music/practice';

export type Instrument = 'guitar' | 'piano';
/** easy = simplified for learning; original = as written in the source. */
export type Level = 'easy' | 'original';
export type Role = 'rhythm' | 'lead';

export interface Settings {
  speed: number; // 0.4 - 1.2
  strumMode: StrumMode;
  /** Per-song extra capo for the chord player (shapes transposed down, sound unchanged). */
  chordCapos: Record<string, number>;
  /** false = no capo at home: the whole song moves down instead (same chord shapes, melody re-fingered). */
  haveCapo: boolean;
  metronome: boolean;
  countIn: boolean;
  muteMelody: boolean;
  muteChords: boolean;
  volMelody: number;
  volChords: number;
  volClick: number;
  latencyMs: number;
  /** Px between strings in the scrolling tab lane (bigger = easier to read). */
  tabSize: number;
  /** Px per beat in the scrolling tab lane. */
  zoom: number;
  chordPlayerName: string;
  melodyPlayerName: string;

  // Each player picks an instrument and a level for their part.
  rhythmInstrument: Instrument;
  rhythmLevel: Level;
  leadInstrument: Instrument;
  leadLevel: Level;
  /** Lead on piano also plays the left hand (one person playing the whole piano part). */
  leadBothHands: boolean;
  /** Easy piano chords: just the root note, or a simple 3-note chord. */
  pianoEasyChords: 'root' | 'triad';

  pianoPractice: PracticeMode;
  /** Accept the right note in any octave (small keyboards, beginners). */
  pianoAnyOctave: boolean;
  /** Play a sound for MIDI keys (turn off for digital pianos with their own speakers). */
  midiSound: boolean;
  volKeys: number;
  /** Px per beat in the falling-notes view. */
  pianoZoom: number;
  /** With two piano parts on screen: which MIDI keyboard each one listens to ('' = any). */
  midiInputRhythm: string;
  midiInputLead: string;
  set: (patch: Partial<Settings>) => void;
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      speed: 0.75,
      strumMode: 'beats',
      chordCapos: {},
      haveCapo: true,
      metronome: true,
      countIn: true,
      muteMelody: false,
      muteChords: false,
      volMelody: 0.9,
      volChords: 0.6,
      volClick: 0.5,
      latencyMs: 0,
      zoom: 130,
      tabSize: 52,
      chordPlayerName: 'Rhythm',
      melodyPlayerName: 'Lead',
      rhythmInstrument: 'guitar',
      rhythmLevel: 'easy',
      leadInstrument: 'guitar',
      leadLevel: 'easy',
      leadBothHands: false,
      pianoEasyChords: 'triad',
      pianoPractice: 'wait',
      pianoAnyOctave: true,
      midiSound: true,
      volKeys: 0.8,
      pianoZoom: 120,
      midiInputRhythm: '',
      midiInputLead: '',
      set: (patch) => set(patch),
    }),
    {
      name: 'turbomusic.settings',
      version: 3,
      migrate: (state, version) => {
        const st = (state ?? {}) as Partial<Settings> & { easyChords?: boolean; pianoHands?: string; pianoLeft?: string };
        // v2: per-song capo became "auto unless chosen" — clear old fixed choices so easy mode can pick.
        if (version < 2) st.chordCapos = {};
        // v3: one "easy" switch became a level per part; piano hands became "lead plays both hands".
        if (version < 3) {
          st.rhythmLevel = st.easyChords === false ? 'original' : 'easy';
          st.leadBothHands = st.pianoHands === 'both';
          st.pianoEasyChords = st.pianoLeft === 'root' ? 'root' : 'triad';
          delete st.easyChords;
          delete st.pianoHands;
          delete st.pianoLeft;
        }
        return st as Settings;
      },
    },
  ),
);

/** Settings keys for a part's instrument / level. */
export const partKeys = {
  rhythm: { instrument: 'rhythmInstrument', level: 'rhythmLevel', midi: 'midiInputRhythm' },
  lead: { instrument: 'leadInstrument', level: 'leadLevel', midi: 'midiInputLead' },
} as const;
