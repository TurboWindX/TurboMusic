/**
 * MusicXML writer: turns the app's timed notes into real sheet music
 * (piano grand staff, or guitar notation + tab), with chord symbols and tempo.
 * Opens in MuseScore / Finale / Sibelius, and is what the in-app sheet view renders.
 */
import { parseChord, type Quality } from '../music/theory';

export interface SheetNote {
  beat: number;
  duration: number;
  midi: number;
  staff: 1 | 2;
  /** Guitar tab only: 0 = low E ... 5 = high e. */
  string?: number;
  fret?: number;
}

export interface SheetPart {
  name: string;
  kind: 'piano' | 'guitar';
  notes: SheetNote[];
  /** Chord symbols above the top staff. */
  chords?: { beat: number; name: string }[];
  capo?: number;
}

export interface SheetScore {
  title: string;
  composer?: string;
  bpm: number;
  beatsPerBar: number;
  parts: SheetPart[];
}

const DIV = 12; // ticks per quarter: 16ths (3) and triplets (4, 8) are whole numbers

/** Note values that can be drawn: ticks -> type, dotted, triplet. Largest first. */
const VALUES: [number, string, boolean, boolean][] = [
  [48, 'whole', false, false], [36, 'half', true, false], [24, 'half', false, false],
  [18, 'quarter', true, false], [12, 'quarter', false, false], [9, 'eighth', true, false],
  [8, 'quarter', false, true], [6, 'eighth', false, false], [4, 'eighth', false, true],
  [3, '16th', false, false], [2, '16th', false, true], [1, '32nd', false, true],
];

const STEP_SHARP: [string, number][] = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];

const KIND: Record<Quality, [string, string?]> = {
  '': ['major'], m: ['minor', 'm'], '7': ['dominant', '7'], m7: ['minor-seventh', 'm7'], maj7: ['major-seventh', 'maj7'],
  sus2: ['suspended-second', 'sus2'], sus4: ['suspended-fourth', 'sus4'], '7sus4': ['dominant', '7sus4'], add9: ['major', 'add9'],
  dim: ['diminished', 'dim'], dim7: ['diminished-seventh', 'dim7'], m7b5: ['half-diminished', 'm7b5'], aug: ['augmented', 'aug'],
  '6': ['major-sixth', '6'], m6: ['minor-sixth', 'm6'], '9': ['dominant-ninth', '9'], m9: ['minor-ninth', 'm9'], maj9: ['major-ninth', 'maj9'], '5': ['power', '5'],
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ticks = (beats: number) => Math.round(beats * DIV);

function pitchXml(midi: number) {
  const [step, alter] = STEP_SHARP[((midi % 12) + 12) % 12];
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${Math.floor(midi / 12) - 1}</octave></pitch>`;
}

function splitTicks(t: number): (typeof VALUES)[number][] {
  const out: (typeof VALUES)[number][] = [];
  while (t > 0) {
    const v = VALUES.find(([n]) => n <= t) ?? VALUES[VALUES.length - 1];
    out.push(v);
    t -= v[0];
  }
  return out;
}

interface Event { start: number; len: number; notes: SheetNote[]; tieIn: Set<number>; tieOut: Set<number> }

/**
 * One voice per staff: a note that is still ringing when the next note in that staff starts
 * is cut there, for the whole piece (so a cut note never reappears as a tie in the next bar).
 */
function oneVoice(notes: SheetNote[]): SheetNote[] {
  const onsets = [...new Set(notes.map((n) => ticks(n.beat)))].sort((a, b) => a - b);
  return notes.map((n) => {
    const s = ticks(n.beat);
    const next = onsets.find((o) => o > s);
    const end = Math.max(s + 1, ticks(n.beat + n.duration));
    return next !== undefined && next < end ? { ...n, duration: (next - s) / DIV } : n;
  });
}

/** One staff of one measure as a single voice: chords at each onset, rests in the gaps. */
function measureEvents(notes: SheetNote[], m0: number, barTicks: number): Event[] {
  const byStart = new Map<number, { n: SheetNote; tieIn: boolean; tieOut: boolean; end: number }[]>();
  for (const n of notes) {
    const s = ticks(n.beat), e = Math.max(s + 1, ticks(n.beat + n.duration));
    if (e <= m0 || s >= m0 + barTicks) continue;
    const cs = Math.max(s, m0) - m0, ce = Math.min(e, m0 + barTicks) - m0;
    const list = byStart.get(cs) ?? [];
    list.push({ n, tieIn: s < m0, tieOut: e > m0 + barTicks, end: ce });
    byStart.set(cs, list);
  }
  const starts = [...byStart.keys()].sort((a, b) => a - b);
  const events: Event[] = [];
  let pos = 0;
  starts.forEach((st, i) => {
    if (st > pos) events.push({ start: pos, len: st - pos, notes: [], tieIn: new Set(), tieOut: new Set() });
    const group = byStart.get(st)!;
    const next = starts[i + 1] ?? barTicks;
    const len = Math.max(1, Math.min(next, Math.min(...group.map((g) => g.end))) - st);
    // A note that rings past the next onset is cut there (one voice per staff keeps the notation readable).
    const seen = new Set<number>();
    const uniq = group.filter((g) => !seen.has(g.n.midi) && seen.add(g.n.midi));
    events.push({
      start: st,
      len,
      notes: uniq.map((g) => g.n),
      tieIn: new Set(uniq.filter((g) => g.tieIn).map((g) => g.n.midi)),
      tieOut: new Set(uniq.filter((g) => g.tieOut && st + len >= g.end).map((g) => g.n.midi)),
    });
    pos = st + len;
  });
  if (pos < barTicks) events.push({ start: pos, len: barTicks - pos, notes: [], tieIn: new Set(), tieOut: new Set() });
  return events;
}

function harmonyXml(name: string, offset: number): string {
  const p = parseChord(name);
  if (!p) return '';
  const [rs, ra] = STEP_SHARP[p.root];
  const [kind, text] = KIND[p.quality] ?? ['major'];
  const bass = p.bass !== null ? `<bass><bass-step>${STEP_SHARP[p.bass][0]}</bass-step>${STEP_SHARP[p.bass][1] ? '<bass-alter>1</bass-alter>' : ''}</bass>` : '';
  return `<harmony><root><root-step>${rs}</root-step>${ra ? `<root-alter>${ra}</root-alter>` : ''}</root><kind${text !== undefined ? ` text="${esc(text)}"` : ''}>${kind}</kind>${bass}${offset ? `<offset>${offset}</offset>` : ''}</harmony>`;
}

function eventXml(ev: Event, staff: number, voice: number, kind: SheetPart['kind']): string {
  const pieces = splitTicks(ev.len);
  let out = '';
  pieces.forEach(([len, type, dotted, triplet], pi) => {
    const tm = triplet ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : '';
    const dot = dotted ? '<dot/>' : '';
    if (!ev.notes.length) {
      out += `<note><rest/><duration>${len}</duration><voice>${voice}</voice><type>${type}</type>${dot}${tm}<staff>${staff}</staff></note>`;
      return;
    }
    ev.notes.forEach((n, ni) => {
      const tieStart = pi < pieces.length - 1 || ev.tieOut.has(n.midi);
      const tieStop = pi > 0 || ev.tieIn.has(n.midi);
      const ties = `${tieStop ? '<tie type="stop"/>' : ''}${tieStart ? '<tie type="start"/>' : ''}`;
      const tied = `${tieStop ? '<tied type="stop"/>' : ''}${tieStart ? '<tied type="start"/>' : ''}`;
      const tech = kind === 'guitar' && staff === 2 && n.string !== undefined && n.fret !== undefined
        ? `<technical><string>${6 - n.string}</string><fret>${n.fret}</fret></technical>` : '';
      const notations = tied || tech ? `<notations>${tied}${tech}</notations>` : '';
      out += `<note>${ni ? '<chord/>' : ''}${pitchXml(n.midi)}<duration>${len}</duration>${ties}<voice>${voice}</voice><type>${type}</type>${dot}${tm}<staff>${staff}</staff>${notations}</note>`;
    });
  });
  return out;
}

const TAB_TUNING = [['E', 2], ['A', 2], ['D', 3], ['G', 3], ['B', 3], ['E', 4]] as const;

function attributes(part: SheetPart, bpb: number): string {
  const clefs = part.kind === 'piano'
    ? '<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>'
    : '<clef number="1"><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef><clef number="2"><sign>TAB</sign><line>5</line></clef>';
  const tab = part.kind === 'guitar'
    ? `<staff-details number="2"><staff-lines>6</staff-lines>${TAB_TUNING.map(([s, o], i) => `<staff-tuning line="${i + 1}"><tuning-step>${s}</tuning-step><tuning-octave>${o}</tuning-octave></staff-tuning>`).join('')}${part.capo ? `<capo>${part.capo}</capo>` : ''}</staff-details>`
    : '';
  return `<attributes><divisions>${DIV}</divisions><key><fifths>0</fifths></key><time><beats>${bpb}</beats><beat-type>4</beat-type></time><staves>2</staves>${clefs}${tab}</attributes>`;
}

export function writeMusicXml(score: SheetScore): string {
  const bpb = score.beatsPerBar;
  const barTicks = bpb * DIV;
  const end = Math.max(bpb, ...score.parts.flatMap((p) => p.notes.map((n) => n.beat + n.duration)));
  const bars = Math.max(1, Math.ceil(end / bpb - 1e-6));

  const partList = score.parts.map((p, i) => `<score-part id="P${i + 1}"><part-name>${esc(p.name)}</part-name></score-part>`).join('');
  const parts = score.parts.map((part, pi) => {
    const voices = { 1: oneVoice(part.notes.filter((n) => n.staff === 1)), 2: oneVoice(part.notes.filter((n) => n.staff === 2)) };
    let xml = `<part id="P${pi + 1}">`;
    for (let m = 0; m < bars; m++) {
      const m0 = m * barTicks;
      xml += `<measure number="${m + 1}">`;
      if (m === 0) {
        xml += attributes(part, bpb);
        if (pi === 0) xml += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(score.bpm)}</per-minute></metronome></direction-type><sound tempo="${Math.round(score.bpm)}"/></direction>`;
        if (part.capo) xml += `<direction placement="above"><direction-type><words>Capo ${part.capo}</words></direction-type></direction>`;
      }
      const harmonies = (part.chords ?? []).filter((c) => ticks(c.beat) >= m0 && ticks(c.beat) < m0 + barTicks);
      for (const staff of [1, 2] as const) {
        const events = measureEvents(voices[staff], m0, barTicks);
        if (staff === 2) xml += `<backup><duration>${barTicks}</duration></backup>`;
        for (const ev of events) {
          if (staff === 1) {
            for (const h of harmonies) {
              const t = ticks(h.beat) - m0;
              if (t >= ev.start && t < ev.start + ev.len) xml += harmonyXml(h.name, t - ev.start);
            }
          }
          xml += eventXml(ev, staff, staff === 1 ? 1 : 5, part.kind);
        }
      }
      if (m === bars - 1) xml += '<barline location="right"><bar-style>light-heavy</bar-style></barline>';
      xml += '</measure>';
    }
    return xml + '</part>';
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><work><work-title>${esc(score.title)}</work-title></work><identification>${score.composer ? `<creator type="composer">${esc(score.composer)}</creator>` : ''}<encoding><software>TurboMusic</software></encoding></identification><part-list>${partList}</part-list>${parts}</score-partwise>`;
}
