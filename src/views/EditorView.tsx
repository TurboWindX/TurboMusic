import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { SONG_DEFAULTS, type Song } from '../../shared/types';
import { api, type ImportResult } from '../api';
import { ImportSheetDialog } from '../components/ImportSheetDialog';
import { guitarFromPiano, type SongFromSheet } from '../import/sheet';
import { buildArrangement } from '../music/arrangement';
import { parseTab } from '../music/tabParser';
import { detectChordChart } from '../music/detectChords';
import { recommendCapo, resolveChord } from '../music/chords';
import { go } from '../router';
import { ChordDiagram } from '../components/ChordDiagram';
import { Timeline } from '../components/Timeline';
import { useSettings } from '../state/settings';

const BLANK: Omit<Song, 'id'> = {
  ...SONG_DEFAULTS,
  title: '',
  artist: '',
  chordChart: '[Verse]\n| C | G | Am | F |\n',
  tab: '',
};

export function EditorView({ id }: { id: string | null }) {
  const [song, setSong] = useState<(Omit<Song, 'id'> & { id?: string }) | null>(id ? null : BLANK);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) { setSong(BLANK); return; }
    api.get(id).then(setSong).catch((e) => setError(String(e.message ?? e)));
  }, [id]);
  if (error) return <div className="center-msg">{error} <a href="#/">Back</a></div>;
  if (!song) return <div className="center-msg">Loading…</div>;
  return <Editor key={id ?? 'new'} initial={song} />;
}

function Editor({ initial }: { initial: Omit<Song, 'id'> & { id?: string } }) {
  const [song, setSong] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const easy = useSettings((s) => s.rhythmLevel === 'easy');
  const zoom = useSettings((s) => s.zoom);

  const patch = (p: Partial<Song>) => { setSong((s) => ({ ...s, ...p })); setDirty(true); };

  const deferred = useDeferredValue(song);
  const arr = useMemo(() => buildArrangement({ ...deferred, id: deferred.id ?? 'preview' }), [deferred]);
  const chordLabel = useCallback((c: string) => c, []);
  const capoTip = useMemo(() => recommendCapo(arr.chords.map((c) => c.chord)), [arr]);

  const save = useCallback(async (thenPlay = false) => {
    if (!song.title.trim()) { setStatus('Give it a title first'); return; }
    try {
      const saved = song.id ? await api.save(song as Song) : await api.create(song);
      setSong(saved);
      setDirty(false);
      setStatus('Saved ✓');
      if (!song.id) window.history.replaceState(null, '', `#/edit/${encodeURIComponent(saved.id)}`);
      if (thenPlay) go({ name: 'play', id: saved.id });
    } catch (e) {
      setStatus(`Save failed: ${(e as Error).message}`);
    }
  }, [song]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); void save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // --- Claude duet arranger
  const [arranging, setArranging] = useState(false);
  const persist = async (next: typeof song) => {
    const saved = next.id ? await api.save(next as Song) : await api.create(next);
    setSong(saved);
    setDirty(false);
    if (!next.id) window.history.replaceState(null, '', `#/edit/${encodeURIComponent(saved.id)}`);
    return saved;
  };
  const runArrange = async (base: typeof song = song) => {
    const source = base.originalTab?.trim() ? base.originalTab : base.tab;
    setArranging(true);
    setStatus('Claude is arranging the duet… this can take a minute or two');
    try {
      const a = await api.arrange({ ...base, tab: source });
      await persist({
        ...base,
        originalTab: source,
        tab: a.melodyTab,
        chordChart: a.chordChart,
        bpm: a.bpm,
        beatsPerBar: a.beatsPerBar,
        melodyStartBar: a.melodyStartBar,
        strumPattern: a.strumPattern,
        tabGrid: 2,
        notes: `Duet arranged by Claude. ${a.notes}`.trim(),
      });
      // Easy mode in the player picks the capo automatically, so nothing to store here.
      setStatus('Duet ready ✓');
    } catch (e) {
      setStatus(`Arranging failed: ${(e as Error).message}`);
    } finally {
      setArranging(false);
    }
  };
  const restoreOriginal = async () => {
    if (!song.originalTab) return;
    await persist({ ...song, tab: song.originalTab, originalTab: undefined, tabGrid: 2 });
    setStatus('Original tab restored ✓');
  };

  // --- sheet music (MIDI / MusicXML / PDF)
  const [sheetOpen, setSheetOpen] = useState(false);
  const [claude, setClaude] = useState(false);
  useEffect(() => { api.config().then((c) => setClaude(c.claude)).catch(() => {}); }, []);
  const importSheet = async (s: SongFromSheet, { replaceGuitar }: { replaceGuitar: boolean }) => {
    setSheetOpen(false);
    const untitled = !song.title.trim() || song.title === 'Untitled';
    try {
      await persist({
        ...song,
        title: untitled ? s.title : song.title,
        artist: song.artist?.trim() ? song.artist : s.artist,
        piano: s.piano,
        bpm: s.bpm,
        beatsPerBar: s.beatsPerBar,
        ...(replaceGuitar ? { tab: s.tab, chordChart: s.chordChart, tabGrid: s.tabGrid, capo: 0, melodyStartBar: 1, originalTab: s.originalTab } : {}),
        notes: `Piano part imported from ${s.piano.source}.${replaceGuitar ? ' Guitar lead and chords were made from it.' : ''}`,
      });
      setStatus(`Sheet music imported ✓ ${s.piano.notes.length} piano notes`);
    } catch (e) {
      setStatus(`Import failed: ${(e as Error).message}`);
    }
  };
  const rebuildGuitar = async () => {
    if (!song.piano) return;
    await persist({ ...song, ...guitarFromPiano(song.piano.notes, song.beatsPerBar) });
    setStatus('Guitar tab and chords rebuilt from the piano part ✓');
  };
  const removePiano = async () => {
    await persist({ ...song, piano: undefined });
    setStatus('Piano part removed: the piano view now follows the tab and chords again');
  };

  // --- one-click import from a tab page
  const [importUrl, setImportUrl] = useState(() =>
    initial.tab.trim() ? '' : (/https:\/\/\S*ultimate-guitar\.com\/tab\/\S+/.exec(initial.notes ?? '')?.[0] ?? ''),
  );
  const [importing, setImporting] = useState(false);
  const runImport = async () => {
    setImporting(true);
    setStatus('Importing…');
    try {
      const r = await api.importUrl(importUrl);
      const saved = await persist(applyImport(song, r));
      const nonStandard = !isStandardTuning(r.tuning);
      setStatus(`Imported and saved ✓${nonStandard ? ` — note: tab is in ${r.tuning} tuning` : ''}`);
      setImportUrl('');
      // Straight on to the duet arrangement when Claude is configured.
      if ((await api.config().catch(() => ({ claude: false }))).claude) {
        setImporting(false);
        await runArrange(saved);
      }
    } catch (e) {
      setStatus(`Import failed: ${(e as Error).message}`);
    } finally {
      setImporting(false);
    }
  };

  const num = (key: keyof Song, label: string, min: number, max: number, hint?: string) => (
    <label className="field">
      <span>{label}{hint && <small className="muted"> {hint}</small>}</span>
      <input
        type="number" min={min} max={max} value={song[key] as number}
        onChange={(e) => patch({ [key]: Number(e.target.value) } as Partial<Song>)}
      />
    </label>
  );

  return (
    <div className="page editor">
      <header className="page-head">
        <h1>
          <a href="#/" className="btn ghost">←</a> {song.id ? 'Edit song' : 'New song'}
          {dirty && <span className="pill warn">unsaved</span>}
        </h1>
        <div className="actions">
          {status && <span className="muted">{status}</span>}
          <button className="btn" onClick={() => void save()}>Save <kbd>Ctrl S</kbd></button>
          <button className="btn primary" onClick={() => void save(true)}>Save & play ▶</button>
        </div>
      </header>

      <section className="import-box">
        <label className="field">
          <span>Import from Ultimate Guitar — paste or keep the link, then press Import</span>
          <div className="import-row">
            <input
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder="https://tabs.ultimate-guitar.com/tab/…"
              onKeyDown={(e) => { if (e.key === 'Enter' && importUrl) void runImport(); }}
            />
            <button className="btn primary big" disabled={!importUrl || importing} onClick={() => void runImport()}>
              {importing ? 'Importing…' : '⬇ Import'}
            </button>
          </div>
        </label>
        <div className="sheet-row">
          <span className="muted">Or bring in sheet music: MIDI, MusicXML, or a PDF / photos of the score.</span>
          <span className="row-gap-inline">
            {song.id && (song.tab.trim() || song.piano) && (
              <a className="btn ghost" href={`#/sheet/${encodeURIComponent(song.id)}`} title="Show this song as piano sheet music or guitar notation + tab; print or download">📄 View as sheet music</a>
            )}
            <button className="btn" onClick={() => setSheetOpen(true)}>🎼 Import sheet music</button>
          </span>
        </div>
        {song.piano && (
          <div className="sheet-row piano-info">
            <span>🎹 <b>Piano part</b> from {song.piano.source} · {song.piano.notes.length} notes
              ({song.piano.notes.filter((n) => n.hand === 'right').length} right hand, {song.piano.notes.filter((n) => n.hand === 'left').length} left)</span>
            <span className="row-gap-inline">
              <button className="btn small" onClick={() => void rebuildGuitar()} title="Replace the guitar lead tab (easy + full) and the chord chart with ones made from the piano part">🎸 Rebuild guitar tab + chords from it</button>
              <button className="btn ghost small" onClick={() => void removePiano()}>Remove piano part</button>
            </span>
          </div>
        )}
      </section>
      {sheetOpen && (
        <ImportSheetDialog
          claude={claude}
          hasGuitarParts={!!(song.tab.trim() || hasChordChart(song.chordChart))}
          onImport={(s, o) => void importSheet(s, o)}
          onClose={() => setSheetOpen(false)}
        />
      )}

      {(song.tab.trim() || song.originalTab) && (
        <section className="import-box arrange-box">
          <div className="arrange-row">
            <div>
              <b>Make it a duet</b>
              <p className="muted">
                Claude rewrites the tab into a simple melody for the lead player and a beginner chord chart that lines up bar
                for bar. Your imported tab is kept and can be restored.
              </p>
            </div>
            <div className="arrange-actions">
              <button className="btn primary big" disabled={arranging} onClick={() => void runArrange()}>
                {arranging ? 'Arranging…' : song.originalTab ? '✨ Re-arrange with Claude' : '✨ Make duet with Claude'}
              </button>
              {song.originalTab && (
                <button className="btn ghost" disabled={arranging} onClick={() => void restoreOriginal()}>Restore original tab</button>
              )}
            </div>
          </div>
        </section>
      )}

      <div className="editor-grid">
        <div className="editor-form">
          <div className="form-grid">
            <label className="field wide">
              <span>Title</span>
              <input value={song.title} onChange={(e) => patch({ title: e.target.value })} placeholder="Song title" />
            </label>
            <label className="field wide">
              <span>Artist</span>
              <input value={song.artist ?? ''} onChange={(e) => patch({ artist: e.target.value })} />
            </label>
            {num('bpm', 'Tempo (BPM)', 20, 300)}
            {num('beatsPerBar', 'Beats per bar', 1, 12)}
            {num('capo', 'Capo', 0, 12, '(as written in source)')}
            {num('melodyStartBar', 'Melody starts at bar', 1, 999)}
            <label className="field">
              <span>Strum pattern <small className="muted">8ths: D U -</small></span>
              <input value={song.strumPattern} onChange={(e) => patch({ strumPattern: e.target.value.toUpperCase() })} />
            </label>
            <label className="field">
              <span>Tab grid</span>
              <select value={song.tabGrid} onChange={(e) => patch({ tabGrid: Number(e.target.value) })}>
                <option value={1}>quarter notes</option>
                <option value={2}>8th notes</option>
                <option value={3}>8th triplets</option>
                <option value={4}>16th notes</option>
              </select>
            </label>
          </div>

          <div className="field">
            <span className="field-head">
              Chord chart
              <button
                type="button" className="btn ghost small" disabled={!song.tab.trim()}
                title="Guess one chord per bar from the melody tab"
                onClick={() => patch({ chordChart: detectedChart(song) })}
              >✨ Detect chords from tab</button>
            </span>
            <textarea
              aria-label="Chord chart"
              className="mono" rows={10} spellCheck={false} value={song.chordChart}
              onChange={(e) => patch({ chordChart: e.target.value })}
            />
          </div>
          <details className="help">
            <summary>Chord chart format</summary>
            <pre>{`[Verse]              section name
| C | Am | F G | % |  one bar per | ; two chords split the bar
| C . . G |           "." holds; here C for 3 beats, G for 1
| F | G | x2          repeat the line
C G Am F              no pipes = one bar per chord`}</pre>
          </details>

          <label className="field">
            <span>Melody tab (ASCII, 6 lines per block, high e on top)</span>
            <textarea
              className="mono" rows={16} spellCheck={false} value={song.tab} wrap="off"
              onChange={(e) => patch({ tab: e.target.value })}
              placeholder={'e|-----0---3---|\nB|---1---------|\nG|-------------|\nD|-------------|\nA|-------------|\nE|-------------|'}
            />
          </label>
          <details className="help">
            <summary>Tab tips</summary>
            <p>
              Paste tab straight from a tab site. Text lines between blocks are ignored. Tab has no rhythm, so
              notes are placed by their column inside each bar and snapped to the grid above. If notes land
              in the wrong spot, try a different grid or space the tab evenly (e.g. 2 dashes per 8th note).
              Use <b>Melody starts at bar</b> when the chords have an intro before the melody comes in.
            </p>
          </details>

          <label className="field">
            <span>Notes</span>
            <textarea rows={3} value={song.notes ?? ''} onChange={(e) => patch({ notes: e.target.value })} />
          </label>
        </div>

        <aside className="editor-preview">
          <h2>Preview</h2>
          <p className="muted">
            {arr.totalBars} bars · {arr.chords.length} chord changes · {arr.melody.length} melody notes ·{' '}
            {arr.sections.map((s) => s.name).join(', ') || 'no sections'}
          </p>
          {arr.warnings.length > 0 && (
            <ul className="warnings">
              {arr.warnings.slice(0, 12).map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          <div className="preview-timeline">
            <Timeline arr={arr} chordLabel={chordLabel} zoom={Math.round(zoom * 0.6)} stringGap={24} live={false} />
          </div>

          <h3>Chords {easy && <small className="muted">(easy mode on)</small>}</h3>
          <div className="chord-gallery">
            {arr.uniqueChords.map((c) => {
              const r = resolveChord(c, { easy });
              return (
                <figure key={c}>
                  <figcaption>{r.display}{r.display !== c && <small> ({c})</small>}</figcaption>
                  <ChordDiagram voicing={r.voicing} name={r.display} size={110} />
                </figure>
              );
            })}
          </div>
          {capoTip && (
            <p className="muted">
              Tip: an extra capo {capoTip.capo} for the chord player gives easier shapes (set it in the player).
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function isStandardTuning(t: string) {
  return /^\s*E\s*A\s*D\s*G\s*B\s*E\s*$/i.test(t) || /standard/i.test(t);
}

/** Merge an imported tab page into the song being edited. */
function applyImport<T extends Omit<Song, 'id'> & { id?: string }>(song: T, r: ImportResult): T {
  // Chords in order, consecutive repeats removed, 4 per line. Timing is a guess: one chord per bar.
  const seq = r.chords.filter((c, i) => c && c !== r.chords[i - 1]);
  const lines: string[] = [];
  for (let i = 0; i < seq.length; i += 4) lines.push('| ' + seq.slice(i, i + 4).join(' | ') + ' |');
  const hasChart = hasChordChart(song.chordChart);
  const tuningNote = isStandardTuning(r.tuning)
    ? ''
    : `\nTuning: ${r.tuning} (the app assumes standard tuning, so notes on retuned strings will sound off in the synth).`;
  let chordChart = song.chordChart;
  let chordNote = '';
  if (!hasChart && lines.length) {
    chordChart = `[Imported chords - one per bar, adjust to fit]\n${lines.join('\n')}`;
  } else if (!hasChart) {
    // Tab-only page: work the chords out from the notes so the rhythm player has a part.
    chordChart = detectedChart({ ...song, tab: r.tab, capo: r.capo });
    chordNote = '\nChords were detected automatically from the tab notes; check them by ear.';
  }
  return {
    ...song,
    title: song.title.trim() || r.title,
    artist: song.artist?.trim() || r.artist,
    tab: r.tab,
    originalTab: undefined,
    capo: r.capo,
    chordChart,
    notes: `Imported from ${r.sourceUrl}${tuningNote}${chordNote}`,
  };
}

function hasChordChart(chart: string) {
  return chart.split('\n').some((l) => l.includes('|') && /[A-G]/.test(l));
}

function detectedChart(song: Pick<Song, 'tab' | 'beatsPerBar' | 'tabGrid' | 'capo' | 'melodyStartBar'>) {
  const tab = parseTab(song.tab, song.beatsPerBar, song.tabGrid);
  const lead = Math.max(0, (song.melodyStartBar || 1) - 1);
  const body = detectChordChart(tab.notes, tab.bars, song.beatsPerBar, song.capo);
  // Chord-only intro bars (if any) repeat the first detected chord.
  const first = /\|\s*([^|\s]+)/.exec(body)?.[1] ?? 'C';
  const intro = lead ? `[Intro]\n| ${Array(lead).fill(first).join(' | ')} |\n` : '';
  return `${intro}[Detected from tab]\n${body}`;
}
