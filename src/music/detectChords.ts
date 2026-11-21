/**
 * Guess a chord per bar (or half bar) from tab notes, so a melody/fingerstyle
 * tab without chord names still gives the rhythm player something to strum.
 */
import type { TabNote } from './tabParser';
import { STANDARD_TUNING, pcName } from './theory';

const TEMPLATES: { q: string; iv: number[]; bias: number }[] = [
  { q: '', iv: [0, 4, 7], bias: 0.3 },
  { q: 'm', iv: [0, 3, 7], bias: 0.3 },
  { q: '7', iv: [0, 4, 7, 10], bias: 0 },
  { q: 'maj7', iv: [0, 4, 7, 11], bias: 0 },
  { q: 'm7', iv: [0, 3, 7, 10], bias: 0 },
  { q: 'sus2', iv: [0, 2, 7], bias: -0.1 },
  { q: 'sus4', iv: [0, 5, 7], bias: -0.1 },
];

interface Guess { name: string; score: number }

/** Best chord for a weighted pitch-class profile. */
export function guessChord(weights: number[], bassPc: number | null, preferFlats = false): Guess | null {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let best: Guess | null = null;
  for (let root = 0; root < 12; root++) {
    for (const t of TEMPLATES) {
      const tones = new Set(t.iv.map((i) => (root + i) % 12));
      let inside = 0, outside = 0;
      weights.forEach((w, pc) => (tones.has(pc) ? (inside += w) : (outside += w)));
      // Missing chord tones cost a little; extensions must earn their place.
      const missing = t.iv.filter((i) => weights[(root + i) % 12] === 0).length;
      let score = (inside - 1.2 * outside) / total - missing * 0.25 + t.bias * (missing === 0 ? 1 : 0.5);
      if (weights[root] > 0) score += 0.15;
      if (bassPc === root) score += 0.35;
      if (!best || score > best.score) best = { name: pcName(root, preferFlats) + t.q, score };
    }
  }
  return best;
}

/**
 * One chord per bar; splits a bar in half when the two halves clearly
 * disagree. Bars without notes repeat the previous chord ("%").
 */
export function detectChordChart(notes: TabNote[], totalBars: number, beatsPerBar: number, capo = 0): string {
  const byBar: TabNote[][] = Array.from({ length: totalBars }, () => []);
  notes.forEach((n) => { if (n.bar < totalBars) byBar[n.bar].push(n); });

  const profile = (ns: TabNote[]) => {
    const w = new Array(12).fill(0);
    let bass: number | null = null, bassMidi = Infinity;
    for (const n of ns) {
      const midi = STANDARD_TUNING[n.string] + n.fret + capo;
      // Longer + lower notes matter more (bass defines harmony in fingerstyle).
      w[midi % 12] += Math.min(n.duration, 2) * (midi < 55 ? 1.5 : 1);
      if (midi < bassMidi) { bassMidi = midi; bass = midi % 12; }
    }
    return { w, bass };
  };

  const bars: string[] = [];
  let prev: string | null = null;
  byBar.forEach((ns) => {
    if (!ns.length) { bars.push(prev ? '%' : 'N.C.'); return; }
    const whole = profile(ns);
    const g = guessChord(whole.w, whole.bass);
    const barStart = ns[0].bar * beatsPerBar;
    const half = beatsPerBar / 2;
    const first = ns.filter((n) => n.beat - barStart < half);
    const second = ns.filter((n) => n.beat - barStart >= half);
    let cell = g?.name ?? prev ?? 'N.C.';
    if (first.length >= 2 && second.length >= 2) {
      const a = profile(first), b = profile(second);
      const ga = guessChord(a.w, a.bass), gb = guessChord(b.w, b.bass);
      if (ga && gb && ga.name !== gb.name && ga.score > 0.5 && gb.score > 0.5 && (ga.score + gb.score) / 2 > (g?.score ?? 0) + 0.25) {
        cell = `${ga.name} ${gb.name}`;
      }
    }
    bars.push(cell);
    prev = cell.split(' ').pop()!;
  });

  // Strip a leading N.C. (rests) to keep the chart parseable: use the first real chord.
  const firstReal = bars.find((b) => b !== 'N.C.' && b !== '%') ?? 'C';
  const cleaned = bars.map((b) => (b === 'N.C.' ? firstReal : b));
  const lines: string[] = [];
  for (let i = 0; i < cleaned.length; i += 4) lines.push('| ' + cleaned.slice(i, i + 4).join(' | ') + ' |');
  return lines.join('\n');
}
