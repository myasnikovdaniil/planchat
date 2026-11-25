// Line diff with context hunks, for showing what changed in a file between
// two snapshots. Pure.

import DiffMatchPatch from "diff-match-patch";

export interface DiffLine {
  /** " " context, "+" added, "-" removed */
  t: " " | "+" | "-";
  s: string;
  /** 1-based line numbers; absent on the side the line does not exist */
  old?: number;
  new?: number;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface LineDiff {
  added: number;
  removed: number;
  hunks: Hunk[];
}

const dmp = new DiffMatchPatch();

/** Lines of a chunk; a trailing line break ends the last line instead of starting an empty one. */
function splitLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

export function diffStats(a: string, b: string): { added: number; removed: number } {
  const { added, removed } = lineDiff(a, b, 0);
  return { added, removed };
}

export function lineDiff(a: string, b: string, context = 3): LineDiff {
  const m = (dmp as any).diff_linesToChars_(a, b) as { chars1: string; chars2: string; lineArray: string[] };
  const diffs = dmp.diff_main(m.chars1, m.chars2, false);
  (dmp as any).diff_charsToLines_(diffs, m.lineArray);

  const all: DiffLine[] = [];
  let o = 1;
  let n = 1;
  let added = 0;
  let removed = 0;
  for (const [op, text] of diffs as [number, string][]) {
    for (const s of splitLines(text)) {
      if (op === DiffMatchPatch.DIFF_EQUAL) all.push({ t: " ", s, old: o++, new: n++ });
      else if (op === DiffMatchPatch.DIFF_DELETE) {
        all.push({ t: "-", s, old: o++ });
        removed++;
      } else {
        all.push({ t: "+", s, new: n++ });
        added++;
      }
    }
  }

  // a window of `context` lines around every changed line; overlapping windows merge
  const ranges: [number, number][] = [];
  all.forEach((l, i) => {
    if (l.t === " ") return;
    const from = Math.max(0, i - context);
    const to = Math.min(all.length, i + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  });
  const hunks: Hunk[] = ranges.map(([from, to]) => ({
    oldStart: firstNumber(all, from, "old"),
    newStart: firstNumber(all, from, "new"),
    lines: all.slice(from, to),
  }));
  return { added, removed, hunks };
}

/** Line number the hunk starts at on one side (for a hunk that begins with lines missing on that side, the next one). */
function firstNumber(all: DiffLine[], from: number, side: "old" | "new"): number {
  for (let k = from; k < all.length; k++) if (all[k][side] !== undefined) return all[k][side]!;
  for (let k = from - 1; k >= 0; k--) if (all[k][side] !== undefined) return all[k][side]! + 1;
  return 1;
}
