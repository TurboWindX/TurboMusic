/**
 * Standard MIDI File (.mid) reader -> SheetImport.
 * Handles format 0 and 1, running status, tempo and time-signature meta events,
 * overlapping notes on the same key. Times come out in quarter-note beats.
 */
import type { ImportedPart, RawNote, SheetImport } from './sheet';

export class SheetError extends Error {}

const GM_FAMILIES = [
  'Piano', 'Chromatic percussion', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass',
  'Reed', 'Pipe', 'Synth lead', 'Synth pad', 'Synth effects', 'Ethnic', 'Percussive', 'Sound effects',
];

class Reader {
  pos = 0;
  constructor(public d: Uint8Array, start = 0, public end = d.length) { this.pos = start; }
  u8() { if (this.pos >= this.end) throw new SheetError('MIDI file is truncated'); return this.d[this.pos++]; }
  u16() { return (this.u8() << 8) | this.u8(); }
  u32() { return ((this.u8() << 24) >>> 0) + (this.u8() << 16) + (this.u8() << 8) + this.u8(); }
  str(n: number) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8()); return s; }
  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    return v;
  }
  bytes(n: number) { const out = this.d.subarray(this.pos, this.pos + n); this.pos += n; return out; }
}

interface Track {
  name?: string;
  /** channel -> notes (ticks) */
  notes: Map<number, { tick: number; end: number; midi: number }[]>;
  programs: Map<number, number>;
}

export function parseMidi(data: Uint8Array, filename = 'song.mid'): SheetImport {
  const r = new Reader(data);
  if (data.length < 14 || r.str(4) !== 'MThd') throw new SheetError('Not a MIDI file (missing MThd header)');
  const hdrLen = r.u32();
  const format = r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  r.pos = 8 + hdrLen;
  if (division & 0x8000) throw new SheetError('SMPTE-timed MIDI files are not supported; re-export with musical (PPQ) timing');
  const ppq = division || 480;

  let tempo: number | null = null; // microseconds per quarter
  let timeSig: [number, number] | null = null;
  let title: string | undefined;
  const tracks: Track[] = [];

  for (let t = 0; t < ntrks && r.pos < data.length - 8; t++) {
    const id = r.str(4);
    const len = r.u32();
    const end = Math.min(data.length, r.pos + len);
    if (id !== 'MTrk') { r.pos = end; t--; continue; }
    const tr = new Reader(data, r.pos, end);
    r.pos = end;
    const track: Track = { notes: new Map(), programs: new Map() };
    const open = new Map<number, { tick: number; midi: number }[]>(); // (ch<<7|key) -> stack
    let tick = 0;
    let status = 0;
    while (tr.pos < end) {
      tick += tr.vlq();
      let b = tr.u8();
      if (b === 0xff) {
        const type = tr.u8();
        const l = tr.vlq();
        const body = tr.bytes(l);
        if (type === 0x03 && !track.name) track.name = latin1(body).trim() || undefined;
        else if (type === 0x51 && l === 3 && tempo === null) tempo = (body[0] << 16) | (body[1] << 8) | body[2];
        else if (type === 0x58 && l >= 2 && timeSig === null) timeSig = [body[0], 2 ** body[1]];
        else if (type === 0x2f) break;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) { tr.bytes(tr.vlq()); continue; }
      let d1: number;
      if (b & 0x80) { status = b; d1 = tr.u8(); } else { if (!status) throw new SheetError('Corrupt MIDI track'); d1 = b; b = status; }
      const cmd = b & 0xf0;
      const ch = b & 0x0f;
      if (cmd === 0xc0 || cmd === 0xd0) {
        if (cmd === 0xc0 && !track.programs.has(ch)) track.programs.set(ch, d1);
        continue;
      }
      const d2 = tr.u8();
      if (cmd === 0x90 && d2 > 0) {
        const k = (ch << 7) | d1;
        if (!open.has(k)) open.set(k, []);
        open.get(k)!.push({ tick, midi: d1 });
      } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
        const on = open.get((ch << 7) | d1)?.shift();
        if (!on) continue;
        if (!track.notes.has(ch)) track.notes.set(ch, []);
        track.notes.get(ch)!.push({ tick: on.tick, end: Math.max(tick, on.tick + 1), midi: on.midi });
      }
    }
    // Notes never released: end them at the track end.
    open.forEach((stack, k) => stack.forEach((on) => {
      const ch = k >> 7;
      if (!track.notes.has(ch)) track.notes.set(ch, []);
      track.notes.get(ch)!.push({ tick: on.tick, end: Math.max(tick, on.tick + ppq), midi: on.midi });
    }));
    if (t === 0 && track.name && format === 1 && !track.notes.size) title = track.name;
    tracks.push(track);
  }

  // One part per (track, channel) that has notes.
  const parts: ImportedPart[] = [];
  tracks.forEach((tr, ti) => {
    tr.notes.forEach((ns, ch) => {
      if (!ns.length) return;
      const program = tr.programs.get(ch);
      const drums = ch === 9;
      const family = program !== undefined ? GM_FAMILIES[program >> 3] : undefined;
      const name = tr.name ?? (drums ? 'Drums' : family ?? `Channel ${ch + 1}`);
      const notes: RawNote[] = ns
        .sort((a, b) => a.tick - b.tick || a.midi - b.midi)
        .map((n) => ({ beat: n.tick / ppq, duration: (n.end - n.tick) / ppq, midi: n.midi }));
      parts.push({
        id: `t${ti}c${ch}`,
        name: tr.notes.size > 1 ? `${name} (ch ${ch + 1})` : name,
        detail: family && tr.name ? family : undefined,
        notes,
        staves: 1,
        drums,
        pianoLike: !drums && (program === undefined || program < 8 || /piano|keys|klavier|rh|lh|right|left/i.test(tr.name ?? '')),
      });
    });
  });
  if (!parts.length) throw new SheetError('This MIDI file has no notes');

  const [num, den] = timeSig ?? [4, 4];
  return {
    format: 'MIDI',
    title: title ?? filename.replace(/\.(mid|midi|kar)$/i, ''),
    bpm: tempo ? Math.round(60_000_000 / tempo) : 120,
    beatsPerBar: Math.max(1, Math.round((num * 4) / den)),
    parts,
    warnings: num * 4 % den !== 0 ? [`Time signature ${num}/${den} is shown as ${Math.round((num * 4) / den)} beats per bar`] : [],
  };
}

function latin1(b: Uint8Array) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return String.fromCharCode(...b); }
}
