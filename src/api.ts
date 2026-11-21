import type { Song, SongSummary } from '../shared/types';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const msg = await res.json().then((j) => j.error).catch(() => res.statusText);
    throw new Error(`${method} ${url}: ${msg}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export interface ImportResult {
  title: string; artist: string; tab: string; chords: string[];
  capo: number; tuning: string; type: string; sourceUrl: string;
}

export interface DuetArrangement {
  bpm: number; beatsPerBar: number; melodyStartBar: number; strumPattern: string;
  chordChart: string; melodyTab: string; suggestedChordCapo: number; notes: string;
}

export interface TranscribeJob {
  status: 'running' | 'done' | 'error';
  elapsed: number;
  error?: string;
  result?: {
    title: string; composer: string; bpm: number; beatsPerBar: number; remarks: string;
    notes: { beat: number; duration: number; midi: number; staff: 1 | 2 }[];
  };
}

export const api = {
  transcribeStart: (files: { name: string; mediaType: string; data: string }[]) =>
    req<{ id: string }>('POST', '/api/transcribe', { files }),
  transcribeStatus: (id: string) => req<TranscribeJob>('GET', `/api/transcribe/${encodeURIComponent(id)}`),
  config: () => req<{ claude: boolean }>('GET', '/api/config'),
  arrange: (song: Omit<Song, 'id'>) => req<DuetArrangement>('POST', '/api/arrange', song),
  importUrl: (url: string) => req<ImportResult>('POST', '/api/import', { url }),
  list: () => req<SongSummary[]>('GET', '/api/songs'),
  get: (id: string) => req<Song>('GET', `/api/songs/${encodeURIComponent(id)}`),
  create: (song: Omit<Song, 'id'>) => req<Song>('POST', '/api/songs', song),
  save: (song: Song) => req<Song>('PUT', `/api/songs/${encodeURIComponent(song.id)}`, song),
  remove: (id: string) => req<void>('DELETE', `/api/songs/${encodeURIComponent(id)}`),
};
