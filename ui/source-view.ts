// Read-only CodeMirror 6 view of the raw file. Every offset that crosses the
// CM boundary goes through LineEndings: CM counts "\r\n" as one position.

import { EditorState, StateEffect, StateField, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, lineNumbers, drawSelection, type DecorationSet } from "@codemirror/view";
import { StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { go } from "@codemirror/lang-go";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { sql } from "@codemirror/lang-sql";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { LineEndings } from "../src/offsets.ts";
import type { ThreadView } from "./api.ts";
import type { DocCallbacks, DocView, Selection } from "./doc-view.ts";

function languageFor(path: string): Extension {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (name === "dockerfile" || ext === "dockerfile") return StreamLanguage.define(dockerFile);
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "md":
    case "markdown":
    case "mdx":
      return markdown();
    case "py":
      return python();
    case "go":
      return go();
    case "rs":
      return rust();
    case "yaml":
    case "yml":
      return yaml();
    case "json":
    case "jsonc":
      return json();
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return html();
    case "css":
    case "scss":
    case "less":
      return css();
    case "sql":
      return sql();
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
      return cpp();
    case "java":
    case "kt":
      return java();
    case "sh":
    case "bash":
    case "zsh":
      return StreamLanguage.define(shell);
    case "toml":
      return StreamLanguage.define(toml);
    default:
      return [];
  }
}

const setMarks = StateEffect.define<DecorationSet>();
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarks)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export class SourceView implements DocView {
  private view: EditorView;
  private le: LineEndings;
  private raw: string;
  private threads: ThreadView[] = [];
  private mouseDown = false;

  constructor(
    private readonly host: HTMLElement,
    path: string,
    content: string,
    private readonly cb: DocCallbacks,
  ) {
    this.raw = content;
    this.le = new LineEndings(content);
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        extensions: [
          EditorState.readOnly.of(true),
          lineNumbers(),
          drawSelection(),
          EditorView.lineWrapping,
          languageFor(path),
          syntaxHighlighting(classHighlighter),
          marksField,
          EditorView.updateListener.of((u) => {
            if (u.geometryChanged || u.heightChanged || u.viewportChanged) this.cb.onLayout();
            if (u.selectionSet && !this.mouseDown) this.reportSelection();
          }),
          EditorView.domEventHandlers({
            mousedown: () => {
              this.mouseDown = true;
              return false;
            },
            mouseup: (e) => {
              this.mouseDown = false;
              // let CM settle the selection first
              setTimeout(() => {
                if (!this.reportSelection()) this.activateAt(e.clientX, e.clientY);
              }, 0);
              return false;
            },
          }),
        ],
      }),
    });
  }

  /** Returns true when there is a non-empty selection. */
  private reportSelection(): boolean {
    const sel = this.view.state.selection.main;
    if (sel.empty) {
      this.cb.onSelect(null);
      return false;
    }
    const start = this.le.cmToRaw(sel.from);
    const end = this.le.cmToRaw(sel.to);
    const a = this.view.coordsAtPos(sel.from);
    const b = this.view.coordsAtPos(sel.to);
    const first = a ?? b;
    const last = b ?? a;
    const rect = first && last
      ? { left: Math.min(first.left, last.left), top: first.top, right: Math.max(first.right, last.right), bottom: last.bottom }
      : { left: 0, top: 0, right: 0, bottom: 0 };
    const s: Selection = { start, end, rect, text: this.raw.slice(start, end) };
    this.cb.onSelect(s);
    return true;
  }

  private activateAt(x: number, y: number): void {
    const pos = this.view.posAtCoords({ x, y });
    if (pos === null) return;
    const raw = this.le.cmToRaw(pos);
    const ids = this.threads
      .filter((t) => t.anchor.state !== "orphaned" && t.anchor.start <= raw && raw < t.anchor.end)
      .sort((a, b) => a.anchor.end - a.anchor.start - (b.anchor.end - b.anchor.start))
      .map((t) => t.id);
    this.cb.onActivate(ids);
  }

  setContent(content: string): void {
    if (content === this.raw) return;
    const oldDoc = this.view.state.doc.toString();
    const next = content.replace(/\r\n?/g, "\n");
    let a = 0;
    const max = Math.min(oldDoc.length, next.length);
    while (a < max && oldDoc.charCodeAt(a) === next.charCodeAt(a)) a++;
    let b = 0;
    while (b < max - a && oldDoc.charCodeAt(oldDoc.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
    this.raw = content;
    this.le = new LineEndings(content);
    this.view.dispatch({ changes: { from: a, to: oldDoc.length - b, insert: next.slice(a, next.length - b) } });
  }

  setThreads(threads: ThreadView[], active: string | null): void {
    this.threads = threads;
    const len = this.view.state.doc.length;
    const ranges: { from: number; to: number; cls: string }[] = [];
    for (const t of threads) {
      if (t.anchor.state === "orphaned") continue;
      const from = Math.min(this.le.rawToCm(t.anchor.start), len);
      const to = Math.min(this.le.rawToCm(t.anchor.end), len);
      if (to <= from) continue;
      const cls = ["planchat-hl", t.status === "resolved" ? "resolved" : "", t.id === active ? "active" : ""].filter(Boolean).join(" ");
      ranges.push({ from, to, cls });
    }
    ranges.sort((x, y) => x.from - y.from || x.to - y.to);
    const b = new RangeSetBuilder<Decoration>();
    for (const r of ranges) b.add(r.from, r.to, Decoration.mark({ class: r.cls }));
    this.view.dispatch({ effects: setMarks.of(b.finish()) });
  }

  anchorTop(t: ThreadView): number | null {
    if (t.anchor.state === "orphaned") return null;
    const pos = Math.min(this.le.rawToCm(t.anchor.start), this.view.state.doc.length);
    const block = this.view.lineBlockAt(pos);
    return block.top + (this.view.documentTop - this.host.getBoundingClientRect().top);
  }

  clearSelection(): void {
    const head = this.view.state.selection.main.head;
    this.view.dispatch({ selection: { anchor: head } });
  }

  destroy(): void {
    this.view.destroy();
  }
}
