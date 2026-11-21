/** Standard MIDI File writer (format 1): a tempo track plus one track per part. */

export interface MidiTrack {
  name: string;
  /** General MIDI program: 0 = acoustic grand piano, 25 = steel-string guitar. */
  program: number;
  notes: { beat: number; duration: number; midi: number; velocity?: number }[];
}

const PPQ = 480;

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const text = (s: string) => [...new TextEncoder().encode(s)];

function chunk(events: number[]) {
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(events.length), ...events];
}

export function writeMidi(opts: { title: string; bpm: number; beatsPerBar: number; tracks: MidiTrack[] }): Uint8Array {
  const tempo = Math.round(60_000_000 / Math.max(20, opts.bpm));
  const name = text(opts.title);
  const head = [
    0, 0xff, 0x03, ...vlq(name.length), ...name,
    0, 0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255,
    0, 0xff, 0x58, 4, opts.beatsPerBar, 2, 24, 8,
    0, 0xff, 0x2f, 0,
  ];
  const chunks = [chunk(head)];
  opts.tracks.forEach((t, i) => {
    const ch = Math.min(i, 8); // keep clear of channel 10 (drums)
    const evs: { tick: number; bytes: number[]; order: number }[] = [];
    for (const n of t.notes) {
      const on = Math.round(n.beat * PPQ);
      const off = Math.max(on + 1, Math.round((n.beat + n.duration) * PPQ));
      const vel = Math.max(1, Math.min(127, Math.round((n.velocity ?? 0.7) * 127)));
      evs.push({ tick: on, bytes: [0x90 | ch, n.midi, vel], order: 1 });
      evs.push({ tick: off, bytes: [0x80 | ch, n.midi, 0], order: 0 }); // offs first at equal ticks
    }
    evs.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const tn = text(t.name);
    const body: number[] = [0, 0xff, 0x03, ...vlq(tn.length), ...tn, 0, 0xc0 | ch, t.program & 0x7f];
    let last = 0;
    for (const e of evs) { body.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
    body.push(0, 0xff, 0x2f, 0);
    chunks.push(chunk(body));
  });
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 1, 0, chunks.length, PPQ >> 8, PPQ & 255, ...chunks.flat()]);
}
