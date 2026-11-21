import { useEffect, useRef, useState } from 'react';
import type { Song, SongSummary } from '../../shared/types';
import { api } from '../api';
import { go } from '../router';
import { SONG_DEFAULTS } from '../../shared/types';
import { ImportSheetDialog } from '../components/ImportSheetDialog';
import type { SongFromSheet } from '../import/sheet';
import { useSettings } from '../state/settings';

export function LibraryView() {
  const [songs, setSongs] = useState<SongSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [claude, setClaude] = useState(false);
  useEffect(() => { api.config().then((c) => setClaude(c.claude)).catch(() => {}); }, []);

  /** New song from sheet music: piano part + guitar lead + chords, then straight to the player on piano. */
  const importSheet = async (s: SongFromSheet) => {
    try {
      const created = await api.create({
        ...SONG_DEFAULTS,
        ...s,
        notes: `Imported from ${s.piano.source}. Guitar lead and chords were made from the piano part.`,
      });
      useSettings.getState().set({ leadInstrument: 'piano' });
      go({ name: 'play', id: created.id });
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setSheetOpen(false);
    }
  };

  const refresh = () => api.list().then(setSongs).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => { void refresh(); }, []);

  const exportSong = async (id: string) => {
    const song = await api.get(id);
    const blob = new Blob([JSON.stringify(song, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importSong = async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as Partial<Song>;
      if (!data.title) throw new Error('JSON has no title');
      const { id: _ignored, ...rest } = data;
      const created = await api.create(rest as Omit<Song, 'id'>);
      await refresh();
      go({ name: 'play', id: created.id });
    } catch (e) {
      setError(`Import failed: ${(e as Error).message}`);
    }
  };

  const remove = async (s: SongSummary) => {
    // Inline confirm (no browser dialogs, they block TV remotes).
    if (pendingDelete !== s.id) { setPendingDelete(s.id); return; }
    await api.remove(s.id);
    setPendingDelete(null);
    void refresh();
  };
  return (
    <div className="page library">
      <header className="page-head">
        <h1><span className="logo">♫</span> TurboMusic</h1>
        <div className="actions">
          <a className="btn" href="#/tuner">Tuner</a>
          <a className="btn" href="#/drill">Chord drill</a>
          <button className="btn" onClick={() => setSheetOpen(true)}>🎼 Import sheet music</button>
          <button className="btn" onClick={() => fileInput.current?.click()}>Import JSON</button>
          <a className="btn primary" href="#/new">+ New song</a>
        </div>
        <input
          ref={fileInput} type="file" accept="application/json,.json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importSong(f); e.target.value = ''; }}
        />
      </header>
      {sheetOpen && <ImportSheetDialog claude={claude} onImport={(s) => void importSheet(s)} onClose={() => setSheetOpen(false)} />}

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {!songs && !error && <p className="muted">Loading…</p>}

      <div className="song-grid">
        {songs?.map((s) => (
          <article key={s.id} className="song-card">
            <a className="song-card-main" href={`#/play/${encodeURIComponent(s.id)}`}>
              <h2>{s.title}</h2>
              {s.artist && <p className="muted">{s.artist}</p>}
            </a>
            <div className="song-card-actions">
              <a className="btn primary" href={`#/play/${encodeURIComponent(s.id)}`}>▶ Play</a>
              <a className="btn" href={`#/edit/${encodeURIComponent(s.id)}`}>Edit</a>
              <button className="btn ghost" onClick={() => void exportSong(s.id)}>Export</button>
              <button className={`btn ghost${pendingDelete === s.id ? ' danger' : ''}`} onClick={() => void remove(s)} onBlur={() => setPendingDelete(null)}>
                {pendingDelete === s.id ? 'Really delete?' : 'Delete'}
              </button>
            </div>
          </article>
        ))}
        {songs?.length === 0 && <p className="muted">No songs yet. Create one!</p>}
      </div>

      <footer className="page-foot muted">
        Tip: open a song, press <kbd>F</kbd> for fullscreen and <kbd>?</kbd> for keys.
      </footer>
    </div>
  );
}
