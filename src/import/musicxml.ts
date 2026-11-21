/**
 * MusicXML reader (.musicxml / .xml, and compressed .mxl) -> SheetImport.
 * Exported by MuseScore, Finale, Sibelius, Dorico, Noteflight, etc.
 *
 * Handles: divisions, chords, backup/forward (multiple voices), ties, grace/cue notes,
 * two-staff piano parts, transposing instruments, pickup bars, and repeats with
 * 1st/2nd endings (expanded so the piece plays through as written).
 */
import { SheetError } from './midi';
import type { ImportedPart, RawNote, SheetImport } from './sheet';

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

interface MeasureData {
  /** Length in beats (quarters). */
  length: number;
  notes: RawNote[]; // beat relative to measure start
}

interface MeasureMeta {
  forward: boolean;
  backward: number; // times to play the repeated block (0 = no repeat sign)
  endingStart: number[] | null;
  endingStop: boolean;
  jump: boolean;
}

export async function parseMusicXmlFile(data: Uint8Array, filename: string): Promise<SheetImport> {
  const isZip = data[0] === 0x50 && data[1] === 0x4b;
  const xml = isZip ? await readMxl(data) : decodeText(data);
  return parseMusicXml(xml, filename);
}

export function parseMusicXml(xml: string, filename = 'score.musicxml'): SheetImport {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new SheetError('This MusicXML file could not be read (invalid XML)');
  const root = doc.documentElement;
  if (root.nodeName === 'score-timewise') throw new SheetError('Timewise MusicXML is not supported; export as standard (partwise) MusicXML');
  if (root.nodeName !== 'score-partwise') throw new SheetError('Not a MusicXML score');

  const warnings: string[] = [];
  const title = text(child(child(root, 'work'), 'work-title')) || text(child(root, 'movement-title')) || filename.replace(/\.(musicxml|xml|mxl)$/i, '');
  const composer = [...root.getElementsByTagName('creator')].find((c) => c.getAttribute('type') === 'composer')?.textContent?.trim();

  const partNames = new Map<string, string>();
  for (const sp of root.getElementsByTagName('score-part')) {
    partNames.set(sp.getAttribute('id') ?? '', text(child(sp, 'part-name')) || text(child(sp, 'part-abbreviation')) || 'Part');
  }

  let bpm: number | null = null;
  let timeSig: [number, number] | null = null;
  let meta: MeasureMeta[] | null = null;
  const parsed: { id: string; name: string; staves: number; drums: boolean; measures: MeasureData[] }[] = [];

  for (const part of children(root, 'part')) {
    let divisions = 1;
    let staves = 1;
    let transpose = 0;
    let drums = false;
    const measures: MeasureData[] = [];
    const partMeta: MeasureMeta[] = [];
    const tied = new Map<string, RawNote>(); // `${staff}:${midi}` -> note awaiting its tie stop (absolute-ish: per measure index)
    let barLen = 4;

    children(part, 'measure').forEach((m, mi) => {
      const notes: RawNote[] = [];
      let cur = 0;
      let maxPos = 0;
      let lastOnset = 0;
      const mm: MeasureMeta = { forward: false, backward: 0, endingStart: null, endingStop: false, jump: false };

      for (const el of Array.from(m.children)) {
        switch (el.nodeName) {
          case 'attributes': {
            const div = num(child(el, 'divisions'));
            if (div) divisions = div;
            const st = num(child(el, 'staves'));
            if (st) staves = st;
            const time = child(el, 'time');
            if (time) {
              const b = num(child(time, 'beats')), bt = num(child(time, 'beat-type'));
              if (b && bt) { barLen = (b * 4) / bt; timeSig ??= [b, bt]; }
            }
            const tr = child(el, 'transpose');
            if (tr) transpose = (num(child(tr, 'chromatic')) ?? 0) + 12 * (num(child(tr, 'octave-change')) ?? 0);
            const clef = child(el, 'clef');
            if (text(child(clef, 'sign')) === 'percussion') drums = true;
            break;
          }
          case 'note': {
            if (child(el, 'grace') || child(el, 'cue')) break;
            const dur = (num(child(el, 'duration')) ?? 0) / divisions;
            const isChord = !!child(el, 'chord');
            const onset = isChord ? lastOnset : cur;
            if (!isChord) { lastOnset = cur; cur += dur; maxPos = Math.max(maxPos, cur); }
            const pitch = child(el, 'pitch');
            if (!pitch || child(el, 'rest')) break;
            const step = STEP[text(child(pitch, 'step')).toUpperCase()];
            if (step === undefined) break;
            const midi = (num(child(pitch, 'octave')) ?? 4) * 12 + 12 + step + Math.round(num(child(pitch, 'alter')) ?? 0) + transpose;
            const staff = num(child(el, 'staff')) ?? 1;
            const ties = [...el.getElementsByTagName('tie'), ...el.getElementsByTagName('tied')].map((t) => t.getAttribute('type'));
            const key = `${staff}:${midi}`;
            const open = tied.get(key);
            if (ties.includes('stop') && open) {
              // Continue the earlier note instead of striking again.
              open.duration += dur;
              if (!ties.includes('start')) tied.delete(key);
              break;
            }
            const note: RawNote = { beat: onset, duration: dur, midi, staff, measure: mi };
            notes.push(note);
            if (ties.includes('start')) tied.set(key, note);
            break;
          }
          case 'backup':
            cur -= (num(child(el, 'duration')) ?? 0) / divisions;
            if (cur < 0) cur = 0;
            break;
          case 'forward':
            cur += (num(child(el, 'duration')) ?? 0) / divisions;
            maxPos = Math.max(maxPos, cur);
            break;
          case 'direction':
          case 'sound': {
            const snd = el.nodeName === 'sound' ? el : el.getElementsByTagName('sound')[0];
            const t = snd && Number(snd.getAttribute('tempo'));
            if (t && bpm === null) bpm = Math.round(t);
            if (snd && (snd.hasAttribute('dacapo') || snd.hasAttribute('dalsegno') || snd.hasAttribute('tocoda'))) mm.jump = true;
            if (bpm === null && el.nodeName === 'direction') {
              const pm = num(el.getElementsByTagName('per-minute')[0]);
              const unit = text(el.getElementsByTagName('beat-unit')[0]);
              if (pm) bpm = Math.round(pm * (unit === 'half' ? 2 : unit === 'eighth' ? 0.5 : 1));
            }
            break;
          }
          case 'barline': {
            const rep = child(el, 'repeat');
            if (rep?.getAttribute('direction') === 'forward') mm.forward = true;
            if (rep?.getAttribute('direction') === 'backward') mm.backward = Number(rep.getAttribute('times')) || 2;
            const end = child(el, 'ending');
            if (end) {
              const type = end.getAttribute('type');
              if (type === 'start') mm.endingStart = (end.getAttribute('number') ?? '1').split(/[,\s]+/).map(Number).filter(Boolean);
              else mm.endingStop = true;
            }
            break;
          }
        }
      }
      // Pickup bars are shorter than the time signature; empty/odd bars fall back to it.
      const implicit = m.getAttribute('implicit') === 'yes';
      const length = maxPos > 0 ? (implicit ? maxPos : Math.max(maxPos, barLen) ) : barLen;
      measures.push({ length, notes });
      partMeta.push(mm);
    });
    meta ??= partMeta;
    const id = part.getAttribute('id') ?? `P${parsed.length + 1}`;
    parsed.push({ id, name: partNames.get(id) ?? id, staves, drums, measures });
  }
  if (!parsed.length || !meta) throw new SheetError('No parts found in this MusicXML file');

  // Play order with repeats expanded (from the first part's barlines).
  const order = playOrder(meta);
  if ((meta as MeasureMeta[]).some((m) => m.jump)) warnings.push('D.C./D.S./Coda jumps are not followed; the piece plays straight through');
  const nMeasures = Math.max(...parsed.map((p) => p.measures.length));
  // Bar lengths shared by all parts: the longest at each index.
  const lengths = Array.from({ length: nMeasures }, (_, i) => Math.max(...parsed.map((p) => p.measures[i]?.length ?? 0)) || 4);
  const starts: number[] = [];
  let t = 0;
  for (const mi of order) { starts.push(t); t += lengths[mi]; }

  const parts: ImportedPart[] = parsed.map((p) => {
    const notes: RawNote[] = [];
    order.forEach((mi, k) => {
      for (const n of p.measures[mi]?.notes ?? []) notes.push({ ...n, beat: starts[k] + n.beat });
    });
    notes.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
    return {
      id: p.id,
      name: p.name,
      notes,
      staves: p.staves,
      drums: p.drums,
      pianoLike: !p.drums && (p.staves === 2 || /piano|keyboard|klavier|pno/i.test(p.name)),
    };
  }).filter((p) => p.notes.length);
  if (!parts.length) throw new SheetError('This score has no notes');

  const [num_, den] = timeSig ?? [4, 4];
  return {
    format: 'MusicXML',
    title,
    composer: composer || undefined,
    bpm: bpm ?? 90,
    beatsPerBar: Math.max(1, Math.round((num_ * 4) / den)),
    parts,
    warnings: bpm === null ? [...warnings, 'No tempo marked in the score; using 90 bpm'] : warnings,
  };
}

/** Measure indices in performance order: |: ... :| repeats and 1st/2nd endings. */
export function playOrder(meta: MeasureMeta[]): number[] {
  // Which ending (if any) each measure belongs to.
  const endingOf: (number[] | null)[] = [];
  let cur: number[] | null = null;
  meta.forEach((m, i) => {
    if (m.endingStart) cur = m.endingStart;
    endingOf[i] = cur;
    if (m.endingStop) cur = null;
  });
  const order: number[] = [];
  const done = new Map<number, number>();
  let start = 0;
  let pass = 1;
  for (let i = 0; i < meta.length && order.length < 20_000; i++) {
    if (meta[i].forward && pass === 1) start = i;
    const end = endingOf[i];
    if (end && !end.includes(pass)) continue;
    order.push(i);
    const times = meta[i].backward;
    if (times) {
      const n = done.get(i) ?? 0;
      if (n < times - 1) {
        done.set(i, n + 1);
        pass++;
        i = start - 1;
        continue;
      }
      pass = 1;
      start = i + 1;
    }
  }
  return order;
}

// ------------------------------------------------------------ helpers

function child(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (const c of Array.from(el.children)) if (c.nodeName === name) return c;
  return null;
}
function children(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((c) => c.nodeName === name);
}
function text(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? '';
}
function num(el: Element | null | undefined): number | null {
  const v = Number(text(el));
  return text(el) !== '' && Number.isFinite(v) ? v : null;
}

function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data);
  return new TextDecoder('utf-8').decode(data);
}

/** .mxl = zip: META-INF/container.xml points at the score file. */
async function readMxl(data: Uint8Array): Promise<string> {
  const files = await unzip(data);
  const container = files.get('META-INF/container.xml');
  let path: string | undefined;
  if (container) {
    const doc = new DOMParser().parseFromString(decodeText(container), 'application/xml');
    path = doc.getElementsByTagName('rootfile')[0]?.getAttribute('full-path') ?? undefined;
  }
  path ??= [...files.keys()].find((k) => !k.startsWith('META-INF') && /\.(xml|musicxml)$/i.test(k));
  const file = path && files.get(path);
  if (!file) throw new SheetError('No score found inside this .mxl file');
  return decodeText(file);
}

/** Minimal zip reader (stored + deflate), enough for .mxl. */
export async function unzip(data: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new SheetError('Damaged .mxl file (not a zip)');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(data.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = data.subarray(start, start + csize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));
  }
  return out;
}

async function inflateRaw(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
