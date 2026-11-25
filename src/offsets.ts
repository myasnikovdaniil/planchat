// Offset translation shared by the daemon and the UI.
//  1. raw file offsets <-> CodeMirror positions (CM6 counts "\r\n" as one);
//  2. rendered markdown characters -> raw source offsets.
// Pure functions, no DOM.

import { decodeNamedCharacterReference } from "decode-named-character-reference";
import type { Root as HastRoot, Element as HastElement, Text as HastText, RootContent, ElementContent } from "hast";

// ---------------------------------------------------------------------------
// raw <-> CodeMirror

/** Positions translate through the list of "\r\n" pairs in the raw text. */
export class LineEndings {
  /** raw index of every '\r' that is followed by '\n' */
  readonly pairs: number[];

  constructor(raw: string) {
    const pairs: number[] = [];
    for (let i = raw.indexOf("\r\n"); i >= 0; i = raw.indexOf("\r\n", i + 2)) pairs.push(i);
    this.pairs = pairs;
  }

  /** Number of elements of a sorted array that satisfy pred (pred is monotone false..true -> count of false prefix). */
  private static countWhile(arr: number[], pred: (v: number, i: number) => boolean): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pred(arr[mid], mid)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** A raw offset between '\r' and '\n' maps to the position after the line break. */
  rawToCm(raw: number): number {
    const before = LineEndings.countWhile(this.pairs, (i) => i + 1 < raw);
    return raw - before;
  }

  cmToRaw(cm: number): number {
    // pair k sits at CM position pairs[k] - k
    const before = LineEndings.countWhile(this.pairs, (i, k) => i - k < cm);
    return cm + before;
  }
}

export function rawToCm(raw: string, offset: number): number {
  return new LineEndings(raw).rawToCm(offset);
}

export function cmToRaw(raw: string, pos: number): number {
  return new LineEndings(raw).cmToRaw(pos);
}

// ---------------------------------------------------------------------------
// rendered markdown -> source

/** Per rendered character: the source span [starts[i], ends[i]) it came from; -1 when unknown. */
export interface CharMap {
  starts: Int32Array;
  ends: Int32Array;
}

export type TextKind = "text" | "inlineCode" | "codeBlock";

interface Cand {
  ch: string;
  off: number;
}

const ENTITY_RE = /^&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

function decodeEntity(source: string, at: number): { decoded: string; length: number } | null {
  const m = ENTITY_RE.exec(source.slice(at, at + 40));
  if (!m) return null;
  let decoded: string | false;
  if (m[1] !== undefined || m[2] !== undefined) {
    const code = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16);
    decoded = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code);
  } else {
    decoded = decodeNamedCharacterReference(m[3]);
  }
  if (decoded === false) return null;
  return { decoded, length: m[0].length };
}

function rangeCands(source: string, start: number, end: number): Cand[] {
  const out: Cand[] = [];
  for (let i = start; i < end; i++) out.push({ ch: source[i], off: i });
  return out;
}

/** Candidates for inline code: strip the backtick fence and one padding space on each side. */
function inlineCodeCands(source: string, start: number, end: number): Cand[] {
  let fence = 0;
  while (start + fence < end && source[start + fence] === "`") fence++;
  let s = start + fence;
  let e = end - fence;
  if (e < s) return [];
  const inner = source.slice(s, e);
  if (inner.length >= 2 && /^[ \r\n]/.test(inner) && /[ \r\n]$/.test(inner) && /[^ \r\n]/.test(inner)) {
    s += 1;
    e -= 1;
  }
  return rangeCands(source, s, e);
}

/** Candidates for a code block: drop the fence lines and the indentation the block strips. */
function codeBlockCands(source: string, start: number, end: number): Cand[] {
  const slice = source.slice(start, end);
  const lines: { text: string; off: number; eol: string }[] = [];
  const re = /\r\n|\r|\n/g;
  let last = 0;
  for (let m = re.exec(slice); m; m = re.exec(slice)) {
    lines.push({ text: slice.slice(last, m.index), off: start + last, eol: m[0] });
    last = m.index + m[0].length;
  }
  lines.push({ text: slice.slice(last), off: start + last, eol: "" });

  const fenceMatch = /^([ \t]*)(`{3,}|~{3,})/.exec(lines[0].text);
  let strip: number;
  let body = lines;
  if (fenceMatch) {
    strip = fenceMatch[1].length;
    body = lines.slice(1);
    const closing = new RegExp(`^[ \\t]*${fenceMatch[2][0] === "`" ? "`" : "~"}{${fenceMatch[2].length},}[ \\t]*$`);
    if (body.length > 0 && closing.test(body[body.length - 1].text)) body = body.slice(0, -1);
    else if (body.length > 0 && body[body.length - 1].text === "" && body[body.length - 1].eol === "") body = body.slice(0, -1);
  } else {
    strip = 4;
  }
  // A block inside a list or blockquote starts at the column after the
  // container prefix; its other lines repeat that prefix ("  ", "> ").
  const lineStart = Math.max(source.lastIndexOf("\n", start - 1), source.lastIndexOf("\r", start - 1)) + 1;
  const containerCols = start - lineStart;
  const out: Cand[] = [];
  body.forEach((line) => {
    let skip = 0;
    while (skip < line.text.length && skip < containerCols && " \t>".includes(line.text[skip])) skip++;
    let col = 0;
    while (skip < line.text.length && col < strip && (line.text[skip] === " " || line.text[skip] === "\t")) {
      col += line.text[skip] === "\t" ? 4 - (col % 4) : 1;
      skip++;
    }
    for (let i = skip; i < line.text.length; i++) out.push({ ch: line.text[i], off: line.off + i });
    for (let j = 0; j < line.eol.length; j++) out.push({ ch: line.eol[j], off: line.off + line.text.length + j });
  });
  return out;
}

/**
 * Align a rendered text value with the source characters it came from.
 * Source characters that do not show up in the value (markup, container
 * prefixes, stripped whitespace) are skipped; escapes and character
 * references map one rendered character onto several source characters.
 * Returns null when the value cannot be aligned.
 */
export function alignText(source: string, start: number, end: number, value: string, kind: TextKind): CharMap | null {
  const cands =
    kind === "inlineCode"
      ? inlineCodeCands(source, start, end)
      : kind === "codeBlock"
        ? codeBlockCands(source, start, end)
        : rangeCands(source, start, end);
  const starts = new Int32Array(value.length).fill(-1);
  const ends = new Int32Array(value.length).fill(-1);
  let i = 0;
  let k = 0;
  while (i < value.length) {
    if (k >= cands.length) {
      // a code block value ends with a newline the source may not have
      if (kind === "codeBlock" && value.slice(i) === "\n") break;
      return null;
    }
    const c = cands[k];
    const v = value[i];
    if (kind === "text") {
      if (c.ch === "\\" && k + 1 < cands.length && cands[k + 1].ch === v && ASCII_PUNCT.test(v) && cands[k + 1].off === c.off + 1) {
        starts[i] = c.off;
        ends[i] = c.off + 2;
        i++;
        k += 2;
        continue;
      }
      if (c.ch === "&") {
        const ent = decodeEntity(source, c.off);
        if (ent && value.startsWith(ent.decoded, i) && c.off + ent.length <= end) {
          for (let j = 0; j < ent.decoded.length; j++) {
            starts[i + j] = c.off;
            ends[i + j] = c.off + ent.length;
          }
          i += ent.decoded.length;
          while (k < cands.length && cands[k].off < c.off + ent.length) k++;
          continue;
        }
      }
    }
    if (c.ch === v) {
      starts[i] = c.off;
      ends[i] = c.off + 1;
      i++;
      k++;
      continue;
    }
    if ((v === "\n" || v === " ") && (c.ch === "\r" || c.ch === "\n")) {
      // CRLF in the source, or a line ending that inline code turned into a space
      const crlf = c.ch === "\r" && cands[k + 1]?.ch === "\n";
      starts[i] = c.off;
      ends[i] = c.off + (crlf ? 2 : 1);
      i++;
      k += crlf ? 2 : 1;
      continue;
    }
    k++;
  }
  return { starts, ends };
}

/** Source range for the rendered characters [a, b) of one text node. */
export function mapSelection(map: CharMap, a: number, b: number): { start: number; end: number } | null {
  if (b <= a) return null;
  let s = -1;
  for (let i = a; i < b && s < 0; i++) s = map.starts[i];
  let e = -1;
  for (let i = b - 1; i >= a && e < 0; i--) e = map.ends[i];
  if (s < 0 || e < 0 || e <= s) return null;
  return { start: s, end: e };
}

/** Indices [from, to) of rendered characters whose source spans intersect [start, end). */
export function renderedRange(map: CharMap, start: number, end: number): { from: number; to: number } | null {
  let from = -1;
  let to = -1;
  for (let i = 0; i < map.starts.length; i++) {
    if (map.starts[i] < 0) continue;
    if (map.ends[i] > start && map.starts[i] < end) {
      if (from < 0) from = i;
      to = i + 1;
    }
  }
  return from < 0 ? null : { from, to };
}

type HastParent = HastRoot | HastElement;

/**
 * Character maps for every text node of a hast tree produced by
 * remark-parse -> remark-rehype. A node maps to null when it has no source
 * position (generated text) or its value does not align with the source.
 */
export function buildRenderMap(source: string, root: HastRoot): Map<HastText, CharMap | null> {
  const out = new Map<HastText, CharMap | null>();
  const visit = (node: HastParent, parent: HastParent | null) => {
    for (const child of node.children as (RootContent | ElementContent)[]) {
      if (child.type === "text") {
        out.set(child, mapTextNode(source, child, node, parent));
      } else if (child.type === "element") {
        visit(child, node);
      }
    }
  };
  visit(root, null);
  return out;
}

function mapTextNode(source: string, text: HastText, parent: HastParent, grand: HastParent | null): CharMap | null {
  const isCodeEl = parent.type === "element" && parent.tagName === "code";
  const inPre = isCodeEl && grand?.type === "element" && grand.tagName === "pre";
  if (inPre) {
    const pos = parent.position ?? (grand as HastElement).position;
    if (!pos || pos.start.offset == null || pos.end.offset == null) return null;
    return alignText(source, pos.start.offset, pos.end.offset, text.value, "codeBlock");
  }
  const pos = text.position;
  if (!pos || pos.start.offset == null || pos.end.offset == null) return null;
  return alignText(source, pos.start.offset, pos.end.offset, text.value, isCodeEl ? "inlineCode" : "text");
}
