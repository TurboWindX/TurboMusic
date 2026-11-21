/**
 * The song as real sheet music: piano grand staff or guitar notation + tab, easy or original.
 * Rendered with OpenSheetMusicDisplay (loaded only when this page opens). Print or download.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Song } from '../../shared/types';
import { api } from '../api';
import { buildScore, scoreToMidi, scoreToMusicXml, type SheetLayout } from '../export/score';
import { go } from '../router';
import { useSettings, type Level } from '../state/settings';

export function SheetView({ id }: { id: string }) {
  const [song, setSong] = useState<Song | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get(id).then(setSong).catch((e) => setError(String(e.message ?? e))); }, [id]);
  if (error) return <div className="center-msg">Couldn’t load song: {error} <a href="#/">Back</a></div>;
  if (!song) return <div className="center-msg">Loading…</div>;
  return <Sheet song={song} />;
}

function Sheet({ song }: { song: Song }) {
  const easyChords = useSettings((s) => s.pianoEasyChords);
  // Start from what the lead player uses in the player.
  const [layout, setLayout] = useState<SheetLayout>(() => useSettings.getState().leadInstrument);
  const [level, setLevel] = useState<Level>(() => useSettings.getState().leadLevel);
  const [status, setStatus] = useState('Drawing the sheet…');
  const host = useRef<HTMLDivElement>(null);

  const score = useMemo(() => buildScore(song, layout, level, easyChords), [song, layout, level, easyChords]);
  const xml = useMemo(() => scoreToMusicXml(score), [score]);
  const empty = score.parts.every((p) => !p.notes.length);

  useEffect(() => {
    if (empty || !host.current) return;
    let cancelled = false;
    setStatus('Drawing the sheet…');
    (async () => {
      const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay');
      if (cancelled || !host.current) return;
      host.current.innerHTML = '';
      const osmd = new OpenSheetMusicDisplay(host.current, {
        backend: 'svg',
        autoResize: true,
        drawTitle: true,
        drawComposer: true,
        drawPartNames: false,
        drawingParameters: 'compacttight',
      });
      await osmd.load(xml);
      if (cancelled) return;
      osmd.render();
      setStatus('');
    })().catch((e: unknown) => !cancelled && setStatus(`Couldn’t draw the sheet: ${e instanceof Error ? e.message : String(e)}`));
    return () => { cancelled = true; };
  }, [xml, empty]);

  const download = (data: BlobPart, ext: string, type: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = `${song.id}-${layout}-${level}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="page sheet-page">
      <header className="page-head no-print">
        <h1><a href={`#/play/${encodeURIComponent(song.id)}`} className="btn ghost">←</a> Sheet music</h1>
        <div className="actions">
          <span className="seg">
            <button className={`seg-btn${layout === 'piano' ? ' active' : ''}`} onClick={() => setLayout('piano')}>🎹 piano</button>
            <button className={`seg-btn${layout === 'guitar' ? ' active' : ''}`} onClick={() => setLayout('guitar')}>🎸 guitar + tab</button>
          </span>
          <span className="seg">
            <button className={`seg-btn${level === 'easy' ? ' active' : ''}`} onClick={() => setLevel('easy')}>easy</button>
            <button className={`seg-btn${level === 'original' ? ' active' : ''}`} onClick={() => setLevel('original')}>original</button>
          </span>
          <button className="btn" onClick={() => window.print()}>🖨 Print</button>
          <button className="btn" onClick={() => download(xml, 'musicxml', 'application/vnd.recordare.musicxml+xml')} title="Open in MuseScore, Finale, Sibelius…">⬇ MusicXML</button>
          <button className="btn" onClick={() => download(scoreToMidi(score) as BlobPart, 'mid', 'audio/midi')}>⬇ MIDI</button>
          <button className="btn primary" onClick={() => go({ name: 'play', id: song.id })}>Play ▶</button>
        </div>
      </header>
      <p className="muted no-print">
        {layout === 'piano'
          ? 'Right hand: the melody. Left hand: the chords. Chord names are as they sound.'
          : `Melody in notes and tab${song.capo ? `, for capo ${song.capo}` : ''}. Chord names are the shapes to play.`}
        {' '}{level === 'easy' ? 'Easy: simplified.' : 'Original: everything as written.'}
      </p>
      {empty && <p className="banner warn">Nothing to show yet: this song has no {layout === 'piano' ? 'notes' : 'tab'}. Add one in the editor.</p>}
      {status && !empty && <p className="muted no-print">{status}</p>}
      <div className="sheet-paper" ref={host} hidden={empty} />
    </div>
  );
}
