/**
 * ASCII guitar tab parser (Ultimate-Guitar style).
 *
 *   e|-----0---3-|--1--0------|
 *   B|---1-------|------------|
 *   G|-----------|------------|
 *   D|-----------|------------|
 *   A|-----------|------------|
 *   E|-----------|------------|
 *
 * Six consecutive tab lines form a block (top line = high e). Bars are split
 * on "|". ASCII tab carries no rhythm, so a note's time inside a bar comes
 * from its column, snapped to a grid (8ths or 16ths). This works well when
 * the tab is evenly spaced; the editor previews the result so you can fix it.
 */

export interface TabNote {
  beat: number; // absolute, from melody start
  bar: number; // 0-based, relative to melody start
  string: number; // 0 = low E ... 5 = high e
  fret: number;
  duration: number; // beats until the next note (capped)
  technique?: string; // h p / \ b ~ etc. preceding/following the fret
}

export interface TabResult {
  bars: number;
  notes: TabNote[];
  warnings: string[];
}

const TAB_LINE_RE = /^\s*([A-Ga-g][#b]?)?\s*[|:]?[-0-9|hpbrt\/\\~xX().*<>sv^= ]*$/;

function isTabLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 4) return false;
  if (!TAB_LINE_RE.test(t)) return false;
  // Must contain several dashes to avoid matching prose like "Am".
  return (t.match(/-/g)?.length ?? 0) >= 3;
}

/** Strip the "e|" prefix; returns the body starting at the first bar line (or first dash). */
function stripPrefix(line: string): string {
  const t = line.replace(/\s+$/, '');
  const m = /^\s*[A-Ga-g]?[#b]?\s*/.exec(t)!;
  return t.slice(m[0].length);
}

export function parseTab(text: string, beatsPerBar: number, grid: number): TabResult {
  const lines = text.split(/\r?\n/);
  const blocks: string[][] = [];
  const warnings: string[] = [];

  let run: string[] = [];
  const flush = () => {
    if (run.length === 6) blocks.push(run);
    else if (run.length > 0) warnings.push(`Skipped a tab block with ${run.length} lines (need 6)`);
    run = [];
  };
  for (const line of lines) {
    if (isTabLine(line)) run.push(stripPrefix(line));
    else flush();
    if (run.length === 6) flush();
  }
  flush();

  const notes: TabNote[] = [];
  const slotsPerBar = beatsPerBar * grid;
  let barIndex = 0;

  blocks.forEach((block, bi) => {
    const width = Math.max(...block.map((l) => l.length));
    const rows = block.map((l) => l.padEnd(width, '-'));
    // Bar lines: columns where most strings have "|".
    const barCols: number[] = [];
    for (let c = 0; c < width; c++) {
      const pipes = rows.filter((r) => r[c] === '|').length;
      if (pipes >= 4) barCols.push(c);
    }
    if (barCols[0] !== 0) barCols.unshift(-1);
    if (barCols[barCols.length - 1] < width - 1) barCols.push(width);

    for (let b = 0; b < barCols.length - 1; b++) {
      const start = barCols[b] + 1;
      const end = barCols[b + 1];
      const segW = end - start;
      if (segW < 2) continue; // double bar line "||"
      const segRows = rows.map((r) => r.slice(start, end));
      const isEmptyEdge = segRows.every((r) => /^[-\s]*$/.test(r)) && (b === 0 || b === barCols.length - 2) && segW < 4;
      if (isEmptyEdge) continue;

      const taken = new Set<string>();
      segRows.forEach((row, rowIdx) => {
        const string = 5 - rowIdx;
        const re = /\d+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(row))) {
          const col = m.index;
          const fret = parseInt(m[0], 10);
          if (fret > 24) {
            warnings.push(`Block ${bi + 1}: fret ${fret} looks wrong — two notes without a dash between?`);
            continue;
          }
          const slot = Math.min(slotsPerBar - 1, Math.floor((col / segW) * slotsPerBar + 1e-6));
          const key = `${string}:${slot}`;
          if (taken.has(key)) continue;
          taken.add(key);
          const before = row[col - 1];
          const after = row[col + m[0].length];
          const tech = [before, after].find((c) => c && /[hpb\/\\~]/.test(c));
          notes.push({
            beat: barIndex * beatsPerBar + slot / grid,
            bar: barIndex,
            string,
            fret,
            duration: 1,
            technique: tech,
          });
        }
      });
      barIndex++;
    }
  });

  notes.sort((a, b) => a.beat - b.beat || a.string - b.string);
  // Duration = gap to next onset, capped at 2 beats.
  for (let i = 0; i < notes.length; i++) {
    let j = i + 1;
    while (j < notes.length && notes[j].beat === notes[i].beat) j++;
    const next = j < notes.length ? notes[j].beat : (notes[i].bar + 1) * beatsPerBar;
    notes[i].duration = Math.min(2, Math.max(1 / grid, next - notes[i].beat));
  }

  if (!blocks.length && text.trim()) warnings.push('No tab blocks found (need 6 lines like "e|---0---|")');
  return { bars: barIndex, notes, warnings };
}
