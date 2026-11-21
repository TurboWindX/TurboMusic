/** Player preferences, persisted to localStorage (per device). */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { StrumMode } from '../music/arrangement';
import type { HandChoice, LeftStyle } from '../music/piano';
import type { PracticeMode } from '../music/practice';

export interface Settings {
  speed: number; // 0.4 - 1.2
  easyChords: boolean;
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
  /** What the lead player reads: guitar tab or piano (falling notes + keyboard). */
  leadInstrument: 'guitar' | 'piano';
  pianoHands: HandChoice;
  pianoLeft: LeftStyle;
  pianoPractice: PracticeMode;
  /** Accept the right note in any octave (small keyboards, beginners). */
  pianoAnyOctave: boolean;
  /** Play a sound for MIDI keys (turn off for digital pianos with their own speakers). */
  midiSound: boolean;
  volKeys: number;
  /** Px per beat in the falling-notes view. */
  pianoZoom: number;
  set: (patch: Partial<Settings>) => void;
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      speed: 0.75,
      easyChords: true,
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
      leadInstrument: 'guitar',
      pianoHands: 'right',
      pianoLeft: 'triad',
      pianoPractice: 'wait',
      pianoAnyOctave: true,
      midiSound: true,
      volKeys: 0.8,
      pianoZoom: 120,
      set: (patch) => set(patch),
    }),
    {
      name: 'turbomusic.settings',
      version: 2,
      // v2: per-song capo became "auto unless chosen" — clear old fixed choices so easy mode can pick.
      migrate: (state, version) => {
        const st = (state ?? {}) as Partial<Settings>;
        if (version < 2) st.chordCapos = {};
        return st as Settings;
      },
    },
  ),
);
