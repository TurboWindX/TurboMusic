/**
 * Chord chart parser.
 *
 * Format (forgiving):
 *   [Verse]                 section header
 *   | C | Am | F G | % |    bars split by "|"; several chords split the bar evenly
 *   | C . . G |             "." holds the previous chord for that slot
 *   | % |                   repeats previous bar
 *   C G Am F                line without pipes: one bar per token
 *   x2 / (x2) after a line  repeats that line
 */
import { parseChord } from './theory';

export interface ChordEvent {
  /** Absolute position in beats from song start. */
  beat: number;
  duration: number;
  chord: string;
  bar: number; // 0-based
}

export interface Section {
  name: string;
  startBar: number; // 0-based
}

export interface ChartResult {
  bars: number;
  chords: ChordEvent[];
  sections: Section[];
  warnings: string[];
}

const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;
const REPEAT_RE = /\(?\s*[xX×]\s*(\d+)\s*\)?\s*$/;

export function parseChordChart(text: string, beatsPerBar: number): ChartResult {
  const barsTokens: string[][] = [];
  const sections: Section[] = [];
  const warnings: string[] = [];

  text.split(/\r?\n/).forEach((rawLine, lineNo) => {
    let line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) return;
    const sec = SECTION_RE.exec(line);
    if (sec) {
      sections.push({ name: sec[1].trim(), startBar: barsTokens.length });
      return;
    }
    let repeat = 1;
    const rep = REPEAT_RE.exec(line);
    if (rep) {
      repeat = Math.max(1, Math.min(32, parseInt(rep[1], 10)));
      line = line.slice(0, rep.index).trim();
    }
    const lineBars: string[][] = line.includes('|')
      ? line.split('|').map((s) => s.trim()).filter(Boolean).map((s) => s.split(/\s+/))
      : line.split(/\s+/).map((tok) => [tok]);

    for (const bar of lineBars) {
      for (const tok of bar) {
        if (tok === '.' || tok === '%' || tok === '-' || tok === '/') continue;
        if (!parseChord(tok)) warnings.push(`Line ${lineNo + 1}: unknown chord "${tok}"`);
      }
    }
    for (let r = 0; r < repeat; r++) barsTokens.push(...lineBars.map((b) => [...b]));
  });

  const chords: ChordEvent[] = [];
  let prev: string | null = null;
  let prevBar: string[] | null = null;
  barsTokens.forEach((tokensIn, bar) => {
    const tokens = tokensIn.length === 1 && tokensIn[0] === '%' && prevBar ? prevBar : tokensIn;
    prevBar = tokens;
    const slot = beatsPerBar / tokens.length;
    tokens.forEach((tok, i) => {
      const beat = bar * beatsPerBar + i * slot;
      const isHold = tok === '.' || tok === '-' || tok === '/' || tok === '%';
      const name = isHold ? prev : tok;
      if (!name) return;
      const last = chords[chords.length - 1];
      if (last && last.chord === name && last.beat + last.duration === beat && isHold) {
        last.duration += slot;
      } else {
        chords.push({ beat, duration: slot, chord: name, bar });
      }
      prev = name;
    });
  });

  return { bars: barsTokens.length, chords, sections, warnings };
}
