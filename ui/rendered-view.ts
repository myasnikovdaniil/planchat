// Rendered markdown with a character map back to the raw source.
// hast (remark-parse -> remark-rehype, positions kept) is turned into DOM by
// hand so every DOM text node keeps the map of the hast text node it came from.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkRehype from "remark-rehype";
import type { Root as HastRoot, Element as HastElement, ElementContent, RootContent } from "hast";
import { buildRenderMap, renderedRange, type CharMap } from "../src/offsets.ts";
import type { ThreadView } from "./api.ts";
import type { DocCallbacks, DocView } from "./doc-view.ts";

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ["yaml", "toml"]).use(remarkRehype);

const ALLOWED = new Set(
  "a abbr blockquote br code del details div em h1 h2 h3 h4 h5 h6 hr img input ins kbd li ol p pre s section span strong sub summary sup table tbody td tfoot th thead tr ul".split(" "),
);

function safeUrl(url: unknown, image = false): string | null {
  if (typeof url !== "string") return null;
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (image && /^data:image\/(png|gif|jpe?g|webp);/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // javascript:, vbscript:, data:, …
  return u; // relative or #fragment
}

const hasHighlights = typeof CSS !== "undefined" && "highlights" in CSS && typeof (globalThis as any).Highlight === "function";

export class RenderedView implements DocView {
  private readonly root: HTMLElement;
  private texts: { node: Text; map: CharMap | null }[] = [];
  private textIndex = new Map<Text, CharMap | null>();
  private threads: ThreadView[] = [];
  private rangesByThread = new Map<string, Range[]>();
  private source = "";
  private ro: ResizeObserver;

  constructor(
    private readonly host: HTMLElement,
    content: string,
    private readonly cb: DocCallbacks,
  ) {
    this.root = document.createElement("div");
    this.root.className = "markdown-body";
    host.appendChild(this.root);
    this.root.addEventListener("mouseup", (e) => setTimeout(() => this.onMouseUp(e), 0));
    this.ro = new ResizeObserver(() => this.cb.onLayout());
    this.ro.observe(this.root);
    this.setContent(content);
  }

  setContent(content: string): void {
    this.source = content;
    const hast = processor.runSync(processor.parse(content)) as HastRoot;
    const maps = buildRenderMap(content, hast);
    this.texts = [];
    this.textIndex = new Map();
    const frag = document.createDocumentFragment();
    const build = (node: HastRoot | HastElement, parent: Node) => {
      for (const child of node.children as (RootContent | ElementContent)[]) {
        if (child.type === "text") {
          const t = document.createTextNode(child.value);
          const map = maps.get(child) ?? null;
          this.texts.push({ node: t, map });
          this.textIndex.set(t, map);
          parent.appendChild(t);
        } else if (child.type === "element") {
          if (!ALLOWED.has(child.tagName)) {
            build(child, parent);
            continue;
          }
          const el = document.createElement(child.tagName);
          const p = child.properties ?? {};
          for (const [k, v] of Object.entries(p)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "className") el.setAttribute("class", Array.isArray(v) ? v.join(" ") : String(v));
            else if (k === "href") {
              const u = safeUrl(v);
              if (u) el.setAttribute("href", u);
            } else if (k === "src") {
              const u = safeUrl(v, true);
              if (u) el.setAttribute("src", u);
            } else if (["alt", "title", "id", "align", "start", "type", "colSpan", "rowSpan"].includes(k)) {
              el.setAttribute(k.toLowerCase(), String(v));
            } else if (k === "checked" || k === "disabled") el.setAttribute(k, "");
          }
          if (child.tagName === "a" && el.getAttribute("href") && !el.getAttribute("href")!.startsWith("#")) {
            el.setAttribute("target", "_blank");
            el.setAttribute("rel", "noopener noreferrer");
          }
          if (child.tagName === "input") el.setAttribute("disabled", "");
          parent.appendChild(el);
          build(child, el);
        }
      }
    };
    build(hast, frag);
    this.root.replaceChildren(frag);
    this.setThreads(this.threads, this.active);
  }

  private active: string | null = null;

  setThreads(threads: ThreadView[], active: string | null): void {
    this.threads = threads;
    this.active = active;
    this.rangesByThread = new Map();
    for (const t of threads) {
      if (t.anchor.state === "orphaned") continue;
      const ranges: Range[] = [];
      for (const { node, map } of this.texts) {
        if (!map) continue;
        const r = renderedRange(map, t.anchor.start, t.anchor.end);
        if (!r) continue;
        const range = document.createRange();
        range.setStart(node, r.from);
        range.setEnd(node, r.to);
        ranges.push(range);
      }
      this.rangesByThread.set(t.id, ranges);
    }
    if (!hasHighlights) return;
    const H = (globalThis as any).Highlight;
    const open = new H();
    const resolved = new H();
    const act = new H();
    for (const t of threads) {
      for (const r of this.rangesByThread.get(t.id) ?? []) {
        (t.status === "resolved" ? resolved : open).add(r);
        if (t.id === active) act.add(r);
      }
    }
    const reg = (CSS as any).highlights;
    reg.set("planchat", open);
    reg.set("planchat-resolved", resolved);
    reg.set("planchat-active", act);
  }

  anchorTop(t: ThreadView): number | null {
    const r = this.rangesByThread.get(t.id)?.[0];
    if (!r) return null;
    const rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
    return rect.top - this.host.getBoundingClientRect().top;
  }

  private onMouseUp(e: MouseEvent): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      this.cb.onSelect(null);
      this.activateAt(e.clientX, e.clientY);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!this.root.contains(range.commonAncestorContainer)) return;
    const hit: { map: CharMap | null; a: number; b: number }[] = [];
    for (const { node, map } of this.texts) {
      if (!range.intersectsNode(node)) continue;
      const a = node === range.startContainer ? range.startOffset : 0;
      const b = node === range.endContainer ? range.endOffset : node.length;
      if (b > a) hit.push({ map, a, b });
    }
    let start = -1;
    let end = -1;
    // An edge that falls in text without a source map is refused, never widened
    // or shrunk to the nearest mapped node.
    const first = hit[0];
    const last = hit[hit.length - 1];
    if (first?.map && last?.map) {
      for (let i = first.a; i < first.b && start < 0; i++) if (first.map.starts[i] >= 0) start = first.map.starts[i];
      for (let i = last.b - 1; i >= last.a && end < 0; i--) if (last.map.ends[i] >= 0) end = last.map.ends[i];
    }
    if (start < 0 || end <= start) {
      this.cb.onUnmappable?.();
      this.cb.onSelect(null);
      return;
    }
    const rects = range.getClientRects();
    const r0 = rects[0] ?? range.getBoundingClientRect();
    const rn = rects[rects.length - 1] ?? r0;
    const box = range.getBoundingClientRect();
    this.cb.onSelect({ start, end, rect: { left: box.left, top: r0.top, right: box.right, bottom: rn.bottom }, text: this.source.slice(start, end) });
  }

  private activateAt(x: number, y: number): void {
    let node: Node | null = null;
    let offset = 0;
    const d = document as any;
    if (d.caretPositionFromPoint) {
      const p = d.caretPositionFromPoint(x, y);
      if (p) ({ offsetNode: node, offset } = p);
    } else if (d.caretRangeFromPoint) {
      const r: Range | null = d.caretRangeFromPoint(x, y);
      if (r) ({ startContainer: node, startOffset: offset } = r);
    }
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const map = this.textIndex.get(node as Text);
    if (!map) return;
    const i = Math.min(offset, map.starts.length - 1);
    const src = map.starts[i];
    if (src < 0) return;
    const ids = this.threads
      .filter((t) => t.anchor.state !== "orphaned" && t.anchor.start <= src && src < t.anchor.end)
      .sort((a, b) => a.anchor.end - a.anchor.start - (b.anchor.end - b.anchor.start))
      .map((t) => t.id);
    if (ids.length) this.cb.onActivate(ids);
  }

  clearSelection(): void {
    window.getSelection()?.removeAllRanges();
  }

  destroy(): void {
    this.ro.disconnect();
    if (hasHighlights) for (const n of ["planchat", "planchat-resolved", "planchat-active"]) (CSS as any).highlights.delete(n);
    this.root.remove();
  }
}
