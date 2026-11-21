/**
 * Chord voicing library: hand-picked open shapes + movable E/A-shape barre
 * generator, with a difficulty score used for "easy mode" and capo advice.
 */
import {
  type ParsedChord, type Quality, chordName, parseChord, simplifyQuality,
  transposeChord, STANDARD_TUNING,
} from './theory';

/** frets[i] for strings low E -> high e; null = muted, 0 = open. */
export interface Voicing {
  frets: (number | null)[];
  /** 0 = open/none, 1-4 = finger. */
  fingers: number[];
  barre?: { fret: number; from: number; to: number };
}

export interface ResolvedChord {
  /** Name shown on screen (may differ from source when simplified). */
  display: string;
  source: string;
  voicing: Voicing | null;
  difficulty: number;
  /** Human note when easy mode swapped something, e.g. "F → Fmaj7". */
  note?: string;
  /** Sounding MIDI notes (without capo), low -> high. */
  midi: number[];
}

type Shape = [string, string]; // frets ("x32010"), fingers ("032010")

/** Open-position shapes. First entry per chord = the "standard" one. */
const OPEN: Record<string, Shape[]> = {
  C: [['x32010', '032010']],
  Cmaj7: [['x32000', '032000']],
  C7: [['x32310', '032410']],
  Cadd9: [['x32033', '021034']],
  Csus2: [['x30013', '030014']],
  Csus4: [['x33011', '034011']],
  D: [['xx0232', '000132']],
  Dm: [['xx0231', '000231']],
  D7: [['xx0212', '000213']],
  Dmaj7: [['xx0222', '000123']],
  Dm7: [['xx0211', '000211']],
  Dsus2: [['xx0230', '000130']],
  Dsus4: [['xx0233', '000134']],
  E: [['022100', '023100']],
  Em: [['022000', '023000']],
  E7: [['020100', '020100']],
  Em7: [['022030', '012030'], ['020000', '020000']],
  Emaj7: [['021100', '031200']],
  Esus4: [['022200', '023400']],
  F: [['133211', '134211'], ['xx3211', '003211']],
  Fmaj7: [['xx3210', '003210']],
  G: [['320003', '210003'], ['320033', '210034']],
  G7: [['320001', '320001']],
  Gmaj7: [['320002', '320001']],
  A: [['x02220', '001230']],
  Am: [['x02210', '002310']],
  A7: [['x02020', '002030']],
  Am7: [['x02010', '002010']],
  Amaj7: [['x02120', '002130']],
  Asus2: [['x02200', '001200']],
  Asus4: [['x02230', '001230']],
  B7: [['x21202', '021304']],
  Bm7: [['x20202', '010203']],
};

/** Movable shapes, frets relative to the root fret. */
const E_SHAPE: Partial<Record<Quality, (number | null)[]>> = {
  '': [0, 2, 2, 1, 0, 0],
  m: [0, 2, 2, 0, 0, 0],
  '7': [0, 2, 0, 1, 0, 0],
  m7: [0, 2, 0, 0, 0, 0],
  maj7: [0, null, 1, 1, 0, null],
  sus4: [0, 2, 2, 2, 0, 0],
  '7sus4': [0, 2, 0, 2, 0, 0],
  '5': [0, 2, 2, null, null, null],
};
const A_SHAPE: Partial<Record<Quality, (number | null)[]>> = {
  '': [null, 0, 2, 2, 2, 0],
  m: [null, 0, 2, 2, 1, 0],
  '7': [null, 0, 2, 0, 2, 0],
  m7: [null, 0, 2, 0, 1, 0],
  maj7: [null, 0, 2, 1, 2, 0],
  sus2: [null, 0, 2, 2, 0, 0],
  sus4: [null, 0, 2, 2, 3, 0],
  '6': [null, 0, 2, 2, 2, 2],
  m6: [null, 0, 2, 2, 1, 2],
  '9': [null, 0, -1, 0, 0, 0],
  dim: [null, 0, 1, 2, 1, null],
  dim7: [null, 0, 1, -1, 1, null],
  m7b5: [null, 0, 1, 0, 1, null],
  aug: [null, 0, -1, -2, -2, null],
  '5': [null, 0, 2, 2, null, null],
};

function parseShape([f, g]: Shape): Voicing {
  const frets = [...f].map((c) => (c === 'x' ? null : parseInt(c, 10)));
  const fingers = [...g].map((c) => parseInt(c, 10) || 0);
  return withBarre({ frets, fingers });
}

/** Detect a barre: same finger on the same fret across 2+ strings. */
function withBarre(v: Voicing): Voicing {
  const byFinger = new Map<number, number[]>();
  v.frets.forEach((fr, s) => {
    const fi = v.fingers[s];
    if (fr && fi) byFinger.set(fi, [...(byFinger.get(fi) ?? []), s]);
  });
  for (const [fi, strings] of byFinger) {
    if (strings.length >= 2 && fi === 1) {
      const fret = v.frets[strings[0]]!;
      if (strings.every((s) => v.frets[s] === fret)) {
        return { ...v, barre: { fret, from: strings[0], to: strings[strings.length - 1] } };
      }
    }
  }
  return v;
}

/** Simple finger assignment for generated shapes. */
function assignFingers(frets: (number | null)[]): Voicing {
  const fingers = frets.map(() => 0);
  const fretted = frets.map((f, s) => ({ f, s })).filter((x) => x.f !== null && x.f > 0) as { f: number; s: number }[];
  if (!fretted.length) return { frets, fingers };
  const min = Math.min(...fretted.map((x) => x.f));
  const atMin = fretted.filter((x) => x.f === min);
  let next = 1;
  let barre: Voicing['barre'];
  if (atMin.length >= 2) {
    // Barre from the lowest string at min fret to the highest played string.
    const from = atMin[0].s;
    const to = Math.max(...fretted.map((x) => x.s));
    barre = { fret: min, from, to };
    atMin.forEach((x) => (fingers[x.s] = 1));
    next = 2;
  }
  fretted
    .filter((x) => fingers[x.s] === 0)
    .sort((a, b) => a.f - b.f || a.s - b.s)
    .forEach((x) => (fingers[x.s] = Math.min(4, next++)));
  return { frets, fingers, barre };
}

function generate(root: number, quality: Quality): Voicing[] {
  const out: Voicing[] = [];
  const add = (shape: (number | null)[] | undefined, openStringPc: number) => {
    if (!shape) return;
    let r = (root - openStringPc + 12) % 12;
    const minRel = Math.min(...shape.filter((x): x is number => x !== null));
    if (r + minRel < 0) r += 12;
    out.push(assignFingers(shape.map((x) => (x === null ? null : x + r))));
  };
  add(E_SHAPE[quality], 4);
  add(A_SHAPE[quality], 9);
  return out;
}

export function difficulty(v: Voicing): number {
  const fretted = v.frets.filter((f): f is number => f !== null && f > 0);
  if (!fretted.length) return 0;
  let d = 0;
  const muted = v.frets.filter((f) => f === null).length;
  if (v.barre) {
    const width = v.barre.to - v.barre.from + 1;
    d += width >= 4 ? 5 : 2;
  }
  const fingersUsed = new Set(v.fingers.filter(Boolean)).size;
  d += fingersUsed;
  const span = Math.max(...fretted) - Math.min(...fretted);
  d += Math.max(0, span - 2) * 1.5;
  if (Math.min(...fretted) > 4) d += 1;
  d += muted > 2 ? 0.5 : 0;
  return d;
}

export function voicingMidi(v: Voicing): number[] {
  return v.frets.flatMap((f, s) => (f === null ? [] : [STANDARD_TUNING[s] + f]));
}

function keyOf(c: ParsedChord): string {
  // Library keys use sharps for black keys except where flats are standard.
  return chordName({ ...c, bass: null, preferFlats: false });
}

export function voicingsFor(c: ParsedChord): Voicing[] {
  const open = OPEN[keyOf(c)]?.map(parseShape) ?? [];
  return [...open, ...generate(c.root, c.quality)];
}

/** Substitutions that beginners commonly use for hard shapes. */
const EASY_SUBS: Record<string, string> = { Bm: 'Bm7', B: 'B7', 'F#m': 'F#m7', 'C#m': 'C#m7' };

/**
 * Resolve a chord symbol to a voicing.
 * easy=true: simplify extensions, drop slash bass, prefer the easiest shape,
 * and apply beginner substitutions when they're clearly easier.
 */
export function resolveChord(text: string, opts: { easy: boolean; shift?: number }): ResolvedChord {
  let parsed = parseChord(text);
  if (!parsed) return { display: text, source: text, voicing: null, difficulty: 99, midi: [] };
  if (opts.shift) parsed = transposeChord(parsed, -opts.shift);

  const pick = (c: ParsedChord, easiest: boolean) => {
    const vs = voicingsFor(c);
    if (!vs.length) return null;
    const v = easiest ? vs.reduce((a, b) => (difficulty(b) < difficulty(a) ? b : a)) : vs[0];
    return { c, v, d: difficulty(v) };
  };

  let target = parsed;
  const notes: string[] = [];
  if (opts.easy) {
    const sq = simplifyQuality(parsed.quality);
    if (sq !== parsed.quality || parsed.bass !== null) {
      target = { ...parsed, quality: sq, bass: null };
    }
  }

  let best = pick(target, opts.easy);
  // Normal mode: fall back to simplified quality if no shape exists at all.
  if (!best) {
    target = { ...target, quality: simplifyQuality(target.quality) };
    best = pick(target, opts.easy);
  }
  if (opts.easy && best) {
    const sub = EASY_SUBS[keyOf(target)];
    if (sub) {
      const subParsed = parseChord(sub)!;
      const alt = pick({ ...subParsed, preferFlats: target.preferFlats }, true);
      if (alt && alt.d + 1 < best.d) best = alt;
    }
  }
  const shown = best ? chordName(best.c) : chordName(target);
  const sourceName = chordName(parsed);
  if (shown !== sourceName) notes.push(`${sourceName} → ${shown}`);
  // Keep the bass note in the label in normal mode for slash chords.
  const display = !opts.easy && parsed.bass !== null && best ? chordName({ ...best.c, bass: parsed.bass }) : shown;

  return {
    display,
    source: text,
    voicing: best?.v ?? null,
    difficulty: best?.d ?? 99,
    note: notes[0],
    midi: best ? voicingMidi(best.v) : [],
  };
}

/** Pick an extra capo (0-7) for the chord player that makes the shapes easiest. */
export function suggestCapo(chords: string[]): { capo: number; score: number }[] {
  const counts = new Map<string, number>();
  chords.forEach((c) => counts.set(c, (counts.get(c) ?? 0) + 1));
  const results: { capo: number; score: number }[] = [];
  for (let capo = 0; capo <= 7; capo++) {
    let score = 0;
    for (const [c, n] of counts) score += resolveChord(c, { easy: true, shift: capo }).difficulty * Math.sqrt(n);
    score += capo * 0.8; // prefer lower capo / original key
    results.push({ capo, score });
  }
  return results.sort((a, b) => a.score - b.score);
}

/** An extra capo worth suggesting, or null when the song is already easy without one. */
export function recommendCapo(chords: string[]): { capo: number; score: number } | null {
  const ranked = suggestCapo(chords);
  const none = ranked.find((r) => r.capo === 0);
  const best = ranked[0];
  return best && none && best.capo !== 0 && best.score < none.score * 0.8 ? best : null;
}
