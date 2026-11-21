/**
 * Import sheet music: MIDI / MusicXML read locally, PDF / photos read by Claude.
 * Shows the parts found so the user can say which is the right and left hand.
 */
import { useMemo, useRef, useState } from 'react';
import { midiName } from '../music/theory';
import { parseSheetFile, SHEET_ACCEPT, sheetKind, transcribeScans, unsupportedHint } from '../import';
import { defaultRoles, ROLE_LABEL, sheetToSong, toPianoNotes, type PartRole, type SheetImport, type SongFromSheet } from '../import/sheet';

interface Props {
  claude: boolean;
  /** Editor: the song already has guitar parts that the import may replace. */
  hasGuitarParts?: boolean;
  onImport: (song: SongFromSheet, opts: { replaceGuitar: boolean }) => void;
  onClose: () => void;
}

type Stage =
  | { name: 'pick' }
  | { name: 'reading'; label: string; seconds?: number }
  | { name: 'review'; sheet: SheetImport; source: string }
  | { name: 'error'; message: string };

export function ImportSheetDialog({ claude, hasGuitarParts, onImport, onClose }: Props) {
  const [stage, setStage] = useState<Stage>({ name: 'pick' });
  const [roles, setRoles] = useState<Record<string, PartRole>>({});
  const [replaceGuitar, setReplaceGuitar] = useState(!hasGuitarParts);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  const load = async (list: FileList | File[]) => {
    const files = [...list];
    if (!files.length) return;
    const kinds = files.map(sheetKind);
    const bad = files.find((_, i) => !kinds[i]);
    if (bad) return setStage({ name: 'error', message: unsupportedHint(bad) });
    try {
      let sheet: SheetImport;
      if (kinds.every((k) => k === 'scan')) {
        if (!claude) {
          return setStage({ name: 'error', message: 'Reading PDFs and photos needs Claude: add ANTHROPIC_API_KEY to .env and restart the server. MIDI and MusicXML files work without it.' });
        }
        abort.current = new AbortController();
        setStage({ name: 'reading', label: `Claude is reading ${files.length > 1 ? `${files.length} pages` : files[0].name}…`, seconds: 0 });
        sheet = await transcribeScans(files, (seconds) => setStage((s) => (s.name === 'reading' ? { ...s, seconds } : s)), abort.current.signal);
      } else {
        if (files.length > 1) return setStage({ name: 'error', message: 'Import one MIDI or MusicXML file at a time (several files are only for photo pages).' });
        setStage({ name: 'reading', label: `Reading ${files[0].name}…` });
        sheet = await parseSheetFile(files[0]);
      }
      setRoles(defaultRoles(sheet));
      setStage({ name: 'review', sheet, source: files.length > 1 ? `${files[0].name} (+${files.length - 1} pages)` : files[0].name });
    } catch (e) {
      setStage({ name: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const close = () => { abort.current?.abort(); onClose(); };

  return (
    <div className="overlay" onClick={close}>
      <div className="panel sheet-import" onClick={(e) => e.stopPropagation()}>
        <h2>Import sheet music</h2>

        {stage.name === 'pick' && (
          <>
            <div
              className={`dropzone${dragging ? ' over' : ''}`}
              onClick={() => input.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); void load(e.dataTransfer.files); }}
            >
              <div className="dropzone-icon">🎼</div>
              <b>Drop a file here or click to choose</b>
              <span className="muted">MIDI (.mid) · MusicXML (.musicxml, .mxl) · PDF or photos of the sheet{claude ? '' : ' (needs Claude)'}</span>
            </div>
            <input ref={input} type="file" accept={SHEET_ACCEPT} multiple hidden onChange={(e) => e.target.files && void load(e.target.files)} />
            <ul className="muted import-tips">
              <li><b>Best:</b> MIDI or MusicXML. Exact notes, read instantly on this computer. MuseScore: <i>File → Export</i>.</li>
              <li><b>PDF / photos</b> (several pages at once is fine): Claude reads the notes. Takes a minute or two, and mistakes are possible.</li>
              <li>You get a piano part (both hands), a guitar lead tab from the melody, and a chord chart for the rhythm player.</li>
            </ul>
          </>
        )}

        {stage.name === 'reading' && (
          <div className="reading">
            <div className="spinner" />
            <p>{stage.label}</p>
            {stage.seconds !== undefined && <p className="muted">{stage.seconds}s · usually 1–3 minutes for a few pages. You can leave this open.</p>}
          </div>
        )}

        {stage.name === 'error' && (
          <>
            <p className="banner error">{stage.message}</p>
            <button className="btn" onClick={() => setStage({ name: 'pick' })}>Try another file</button>
          </>
        )}

        {stage.name === 'review' && (
          <Review
            sheet={stage.sheet}
            roles={roles}
            setRoles={setRoles}
            hasGuitarParts={!!hasGuitarParts}
            replaceGuitar={replaceGuitar}
            setReplaceGuitar={setReplaceGuitar}
            onBack={() => setStage({ name: 'pick' })}
            onCancel={close}
            onImport={() => {
              try {
                onImport(sheetToSong(stage.sheet, roles, stage.source), { replaceGuitar });
              } catch (e) {
                setStage({ name: 'error', message: e instanceof Error ? e.message : String(e) });
              }
            }}
          />
        )}

        {stage.name !== 'review' && (
          <div className="sheet-import-foot">
            <button className="btn ghost" onClick={close}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Review(props: {
  sheet: SheetImport;
  roles: Record<string, PartRole>;
  setRoles: (r: Record<string, PartRole>) => void;
  hasGuitarParts: boolean;
  replaceGuitar: boolean;
  setReplaceGuitar: (v: boolean) => void;
  onBack: () => void;
  onCancel: () => void;
  onImport: () => void;
}) {
  const { sheet, roles } = props;
  const notes = useMemo(() => toPianoNotes(sheet, roles), [sheet, roles]);
  const right = notes.filter((n) => n.hand === 'right').length;
  const bars = notes.length ? Math.ceil(Math.max(...notes.map((n) => n.beat + n.duration)) / sheet.beatsPerBar) : 0;

  return (
    <>
      <p>
        <b>{sheet.title}</b>{sheet.composer && <span className="muted"> · {sheet.composer}</span>}
        <br />
        <span className="muted">{sheet.format} · {sheet.bpm} bpm · {sheet.beatsPerBar} beats per bar · {bars} bars</span>
      </p>
      {sheet.warnings.map((w, i) => <p key={i} className="banner warn">{w}</p>)}

      <table className="parts-table">
        <thead><tr><th>Part</th><th>Notes</th><th>Range</th><th>Use as</th></tr></thead>
        <tbody>
          {sheet.parts.map((p) => {
            const lo = Math.min(...p.notes.map((n) => n.midi));
            const hi = Math.max(...p.notes.map((n) => n.midi));
            const options: PartRole[] = ['auto', 'right', 'left', 'off'];
            return (
              <tr key={p.id} className={roles[p.id] === 'off' ? 'off' : ''}>
                <td>{p.name}{p.detail && <small className="muted"> · {p.detail}</small>}{p.staves >= 2 && <small className="muted"> · 2 staves</small>}{p.drums && <small className="muted"> · drums</small>}</td>
                <td>{p.notes.length}</td>
                <td>{midiName(lo)}–{midiName(hi)}</td>
                <td>
                  <select value={roles[p.id]} onChange={(e) => props.setRoles({ ...roles, [p.id]: e.target.value as PartRole })}>
                    {options.map((o) => (
                      <option key={o} value={o}>{o === 'auto' ? (p.staves >= 2 ? 'both hands (by staff)' : ROLE_LABEL.auto) : ROLE_LABEL[o]}</option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <MiniRoll notes={notes} beatsPerBar={sheet.beatsPerBar} />
      <p className="muted">
        <span className="hand-dot right" /> right hand {right} notes · <span className="hand-dot left" /> left hand {notes.length - right} notes
        {' '}(first 16 bars shown)
      </p>

      {props.hasGuitarParts ? (
        <label className="field check">
          <input type="checkbox" checked={props.replaceGuitar} onChange={(e) => props.setReplaceGuitar(e.target.checked)} />
          <span>Also replace the guitar lead tab and chord chart with ones made from this sheet</span>
        </label>
      ) : (
        <p className="muted">The guitar lead tab (melody) and the chord chart are made from this sheet too.</p>
      )}

      <div className="row-gap">
        <button className="btn ghost" onClick={props.onCancel}>Cancel</button>
        <button className="btn" onClick={props.onBack}>← Other file</button>
        <button className="btn primary" disabled={!notes.length} onClick={props.onImport}>Import {notes.length} notes</button>
      </div>
    </>
  );
}

/** Small piano-roll preview so a wrong hand split is obvious at a glance. */
function MiniRoll({ notes, beatsPerBar }: { notes: { beat: number; duration: number; midi: number; hand: string }[]; beatsPerBar: number }) {
  const maxBeat = beatsPerBar * 16;
  const shown = notes.filter((n) => n.beat < maxBeat);
  if (!shown.length) return null;
  const lo = Math.min(...shown.map((n) => n.midi)) - 1;
  const hi = Math.max(...shown.map((n) => n.midi)) + 1;
  const W = 1000, H = 160;
  const x = (b: number) => (b / maxBeat) * W;
  const y = (m: number) => H - ((m - lo) / (hi - lo)) * H;
  return (
    <svg className="mini-roll" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {Array.from({ length: 17 }, (_, i) => <line key={i} x1={x(i * beatsPerBar)} x2={x(i * beatsPerBar)} y1={0} y2={H} className="mr-bar" />)}
      <line x1={0} x2={W} y1={y(60)} y2={y(60)} className="mr-c4" />
      {shown.map((n, i) => (
        <rect key={i} x={x(n.beat)} y={y(n.midi) - 2} width={Math.max(2, x(n.duration) - 1)} height={4} rx={1.5} className={`mr-${n.hand}`} />
      ))}
    </svg>
  );
}
