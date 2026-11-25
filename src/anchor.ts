// Anchors on raw file text and their re-anchoring after the file changes.
// Pure functions: no I/O, no clock. Offsets are UTF-16 code units of the raw
// file (CRLF counts as two).

import DiffMatchPatch from "diff-match-patch";

export const CONTEXT_CHARS = 32;

export type AnchorState = "ok" | "moved" | "edited" | "orphaned";

export type OrphanReason =
  | "deleted" // the anchored range was removed by the diff
  | "ambiguous" // diff may have kept the wrong duplicate
  | "not-found" // no snapshot and the quote is gone
  | "context" // quote present but no occurrence has matching context
  | "multiple" // more than one occurrence matches the context
  | "file-deleted";

export interface Anchor {
  file: string;
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
  fileHash: string;
  state: AnchorState;
  reason?: OrphanReason;
}

export interface Quote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface MapResult {
  start: number;
  end: number;
  state: AnchorState;
  reason?: OrphanReason;
}

const SEVERITY: Record<AnchorState, number> = { ok: 0, moved: 1, edited: 2, orphaned: 3 };

/** The more severe of two states; an anchor never goes back from edited to ok. */
export function worstState(a: AnchorState, b: AnchorState): AnchorState {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

const dmp = new DiffMatchPatch();
dmp.Diff_Timeout = 2;

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Move a range outward so it never splits a surrogate pair. */
export function snapToCodePoints(text: string, start: number, end: number): { start: number; end: number } {
  if (start > 0 && start < text.length && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) start--;
  if (end > 0 && end < text.length && isLow(text.charCodeAt(end)) && isHigh(text.charCodeAt(end - 1))) end++;
  return { start, end };
}

export function quoteAt(text: string, start: number, end: number): Quote {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: text.slice(end, end + CONTEXT_CHARS),
  };
}

export class AnchorError extends Error {}

export function makeAnchor(file: string, text: string, start: number, end: number, fileHash: string): Anchor {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) {
    throw new AnchorError(`invalid range [${start}, ${end}) for a file of ${text.length} code units`);
  }
  ({ start, end } = snapToCodePoints(text, start, end));
  return { file, start, end, ...quoteAt(text, start, end), fileHash, state: "ok" };
}

/** Find the nth (0-based) occurrence of `exact`; used by create_thread with {exact, nth}. */
export function rangeOfExact(text: string, exact: string, nth = 0): { start: number; end: number } | null {
  if (!exact) return null;
  let from = 0;
  for (let i = 0; ; i++) {
    const at = text.indexOf(exact, from);
    if (at < 0) return null;
    if (i === nth) return { start: at, end: at + exact.length };
    from = at + 1;
  }
}

export function countOccurrences(text: string, exact: string): number {
  if (!exact) return 0;
  let n = 0;
  for (let at = text.indexOf(exact); at >= 0; at = text.indexOf(exact, at + 1)) n++;
  return n;
}

type Diff = [number, string];

/**
 * Map an old boundary through a diff. Text inserted exactly at a boundary
 * stays outside the range (assoc > 0 for starts puts the boundary after it,
 * assoc < 0 for ends before it) — unless the insert sits next to a deletion
 * inside the range: then it replaces anchored text and belongs to the range.
 */
function mapBoundary(diffs: Diff[], p: number, assoc: 1 | -1, inside: (o: number) => boolean): number {
  let o = 0;
  let n = 0;
  for (let i = 0; i < diffs.length; i++) {
    const [op, text] = diffs[i];
    const len = text.length;
    if (op === DiffMatchPatch.DIFF_INSERT) {
      if (o === p) {
        const prev = diffs[i - 1];
        const next = diffs[i + 1];
        const replacesBefore = prev?.[0] === DiffMatchPatch.DIFF_DELETE && inside(o - 1);
        const replacesAfter = next?.[0] === DiffMatchPatch.DIFF_DELETE && inside(o);
        if (assoc < 0 && !replacesBefore) return n;
        if (assoc > 0 && replacesAfter) return n;
      }
      n += len;
      continue;
    }
    if (p < o + len) return op === DiffMatchPatch.DIFF_EQUAL ? n + (p - o) : n;
    o += len;
    if (op === DiffMatchPatch.DIFF_EQUAL) n += len;
  }
  return n;
}

export function diffTexts(oldText: string, newText: string): Diff[] {
  const diffs = dmp.diff_main(oldText, newText) as Diff[];
  dmp.diff_cleanupSemantic(diffs);
  return diffs;
}

/**
 * Carry [start, end) of oldText over to newText through a character diff.
 *  - untouched range: ok, or moved when its offset changed;
 *  - changed but still non-empty (including the anchored text replaced in
 *    place): edited;
 *  - removed with nothing in its place: orphaned (deleted);
 *  - untouched, but some deleted chunk also contains the anchored text: the
 *    diff may have kept the wrong duplicate, so orphaned (ambiguous).
 */
export function mapRange(oldText: string, newText: string, start: number, end: number): MapResult {
  if (oldText === newText) return { start, end, state: "ok" };
  const diffs = diffTexts(oldText, newText);
  let o = 0;
  let touched = false;
  const deleted: string[] = [];
  for (const [op, text] of diffs) {
    const len = text.length;
    if (op === DiffMatchPatch.DIFF_INSERT) {
      if (o > start && o < end) touched = true;
      continue;
    }
    const segEnd = o + len;
    if (op === DiffMatchPatch.DIFF_DELETE) {
      if (Math.min(end, segEnd) > Math.max(start, o)) touched = true;
      deleted.push(text);
    }
    o = segEnd;
  }

  const inside = (x: number) => x >= start && x < end;
  let ns = mapBoundary(diffs, start, 1, inside);
  let ne = mapBoundary(diffs, end, -1, inside);
  ({ start: ns, end: ne } = snapToCodePoints(newText, ns, ne));
  if (ne <= ns) return { start, end, state: "orphaned", reason: "deleted" };

  if (touched) return { start: ns, end: ne, state: "edited" };

  const exact = oldText.slice(start, end);
  if (deleted.some((chunk) => chunk.includes(exact))) {
    return { start, end, state: "orphaned", reason: "ambiguous" };
  }
  return { start: ns, end: ne, state: ns === start ? "ok" : "moved" };
}

/** 1 for identical strings, 0 for nothing in common (normalised Levenshtein). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  const distance = dmp.diff_levenshtein(dmp.diff_main(a, b) as Diff[]);
  return 1 - distance / longest;
}

/**
 * Locate a quote without a snapshot of the old file. Accepted only when
 * `exact` occurs exactly once and both its prefix and suffix are similar
 * enough to the stored context. Two occurrences are never told apart by
 * context alone: a false orphan beats a comment on the wrong place.
 */
export function findByQuote(text: string, quote: Quote, threshold: number, previousStart = -1): MapResult {
  const { exact, prefix, suffix } = quote;
  const fail = (reason: OrphanReason): MapResult => ({ start: 0, end: 0, state: "orphaned", reason });
  if (!exact) return fail("not-found");
  const at = text.indexOf(exact);
  if (at < 0) return fail("not-found");
  if (text.indexOf(exact, at + 1) >= 0) return fail("multiple");
  const before = text.slice(Math.max(0, at - prefix.length), at);
  const after = text.slice(at + exact.length, at + exact.length + suffix.length);
  if (similarity(prefix, before) < threshold || similarity(suffix, after) < threshold) return fail("context");
  return { start: at, end: at + exact.length, state: at === previousStart ? "ok" : "moved" };
}

/**
 * Re-anchor after a file change. `oldText` is the snapshot the anchor was
 * computed against (anchor.fileHash), or null when that snapshot is lost.
 * Orphaned anchors stay orphaned until a human re-anchors them.
 */
export function reanchor(anchor: Anchor, oldText: string | null, newText: string, newHash: string, threshold: number): Anchor {
  if (anchor.state === "orphaned") return anchor;
  if (anchor.fileHash === newHash) return anchor;
  const result =
    oldText !== null
      ? mapRange(oldText, newText, anchor.start, anchor.end)
      : findByQuote(newText, anchor, threshold, anchor.start);
  if (result.state === "orphaned") {
    return { ...anchor, fileHash: newHash, state: "orphaned", reason: result.reason };
  }
  const { reason: _drop, ...rest } = anchor;
  return {
    ...rest,
    start: result.start,
    end: result.end,
    ...quoteAt(newText, result.start, result.end),
    fileHash: newHash,
    state: worstState(anchor.state, result.state),
  };
}

/**
 * Translate a selection made on an older version of the file (the one the UI
 * saw) onto the current text. Returns null when the translation is not safe:
 * the selected text changed, vanished or the diff is ambiguous.
 */
export function translateSelection(
  baseText: string,
  currentText: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (baseText === currentText) return { start, end };
  const r = mapRange(baseText, currentText, start, end);
  if (r.state !== "ok" && r.state !== "moved") return null;
  return { start: r.start, end: r.end };
}

/** 1-based line numbers of the first and last character of [start, end). */
export function lineRange(text: string, start: number, end: number): { from: number; to: number } {
  const lineAt = (offset: number) => {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10) line++;
      else if (c === 13 && text.charCodeAt(i + 1) !== 10) line++;
    }
    return line;
  };
  const from = lineAt(start);
  const to = end > start ? lineAt(end - 1) : from;
  return { from, to };
}
