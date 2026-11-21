/**
 * Stored song document. Raw text (chord chart + ASCII tab) is the single
 * source of truth; the app parses it into timed events at load time.
 */
export interface Song {
  id: string;
  title: string;
  artist?: string;
  bpm: number;
  /** Beats per bar (time signature numerator, quarter-note beats). */
  beatsPerBar: number;
  /** Capo the source chords/tab are written for (affects sounding pitch). */
  capo: number;
  /** 8th-note strum slots, e.g. "D-DU-UDU" (D = down, U = up, - = rest). */
  strumPattern: string;
  /** Tab quantisation: subdivisions per beat (2 = 8ths, 4 = 16ths). */
  tabGrid: number;
  /** Bar (1-based) where the melody tab starts — for chord-only intros. */
  melodyStartBar: number;
  chordChart: string;
  tab: string;
  /** The tab as imported, kept when Claude rewrites `tab` into a simplified melody. */
  originalTab?: string;
  notes?: string;
  updatedAt?: string;
}

export interface SongSummary {
  id: string;
  title: string;
  artist?: string;
  updatedAt?: string;
}

export const SONG_DEFAULTS: Omit<Song, 'id' | 'title' | 'chordChart' | 'tab'> = {
  bpm: 80,
  beatsPerBar: 4,
  capo: 0,
  strumPattern: 'D-DU-UDU',
  tabGrid: 2,
  melodyStartBar: 1,
};

/** Fill in any missing fields so older/hand-written JSON still loads. */
export function normalizeSong(raw: Partial<Song> & { id: string }): Song {
  return {
    ...SONG_DEFAULTS,
    title: 'Untitled',
    chordChart: '',
    tab: '',
    ...raw,
  };
}
