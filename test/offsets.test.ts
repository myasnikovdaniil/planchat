import { describe, expect, test } from "bun:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import type { Root as HastRoot, Text as HastText, Element as HastElement } from "hast";
import { LineEndings, buildRenderMap, mapSelection, renderedRange, type CharMap } from "../src/offsets.ts";

describe("raw <-> CodeMirror", () => {
  test("a\\r\\nb: `b` at CM 2 is raw 3 and back", () => {
    const le = new LineEndings("a\r\nb");
    expect(le.cmToRaw(2)).toBe(3);
    expect(le.rawToCm(3)).toBe(2);
    expect(le.cmToRaw(0)).toBe(0);
    expect(le.cmToRaw(1)).toBe(1);
  });

  test("mixed \\n and \\r\\n", () => {
    const raw = "ab\ncd\r\nef\ngh\r\n\r\nij";
    const cm = raw.replace(/\r\n/g, "\n");
    const le = new LineEndings(raw);
    for (const word of ["ab", "cd", "ef", "gh", "ij"]) {
      const r = raw.indexOf(word);
      const c = cm.indexOf(word);
      expect(le.rawToCm(r)).toBe(c);
      expect(le.cmToRaw(c)).toBe(r);
      expect(le.cmToRaw(c + 2)).toBe(r + 2);
    }
    // every CM position round-trips
    for (let c = 0; c <= cm.length; c++) expect(le.rawToCm(le.cmToRaw(c))).toBe(c);
  });

  test("lone \\r is one position in both", () => {
    const le = new LineEndings("a\rb");
    expect(le.cmToRaw(2)).toBe(2);
  });
});

function render(md: string): HastRoot {
  const proc = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
  return proc.runSync(proc.parse(md)) as HastRoot;
}

/** Text nodes in document order with their maps; rendered text concatenated. */
function textNodes(md: string) {
  const root = render(md);
  const maps = buildRenderMap(md, root);
  const nodes: { node: HastText; map: CharMap | null }[] = [];
  const walk = (n: HastRoot | HastElement) => {
    for (const c of n.children) {
      if (c.type === "text") nodes.push({ node: c, map: maps.get(c) ?? null });
      else if (c.type === "element") walk(c);
    }
  };
  walk(root);
  return nodes;
}

/** Select `needle` in the rendered text of the first node containing it; return the source substring. */
function selectRendered(md: string, needle: string, nth = 0): string | null {
  const nodes = textNodes(md).filter((n) => n.node.value.includes(needle));
  const hit = nodes[nth];
  if (!hit || !hit.map) return null;
  const a = hit.node.value.indexOf(needle);
  const r = mapSelection(hit.map, a, a + needle.length);
  return r ? md.slice(r.start, r.end) : null;
}

describe("rendered markdown -> source", () => {
  test("`beta` inside inline code `alpha beta`", () => {
    const md = "Use `alpha beta` here.\n";
    expect(selectRendered(md, "beta")).toBe("beta");
    expect(selectRendered(md, "alpha beta")).toBe("alpha beta");
  });

  test("inline code with a double-backtick fence and padding", () => {
    const md = "x `` a`b `` y\n";
    expect(selectRendered(md, "a`b")).toBe("a`b");
  });

  test("**x**", () => {
    const md = "a **x** b\n";
    expect(selectRendered(md, "x")).toBe("x");
  });

  test("[link](url)", () => {
    const md = "see [link](https://example.com) now\n";
    expect(selectRendered(md, "link")).toBe("link");
    expect(selectRendered(md, "see ")).toBe("see ");
  });

  test("&amp; maps to the whole reference", () => {
    const md = "a &amp; b\n";
    expect(selectRendered(md, "&")).toBe("&amp;");
    expect(selectRendered(md, "a & b")).toBe("a &amp; b");
    expect(selectRendered(md, "b")).toBe("b");
  });

  test("numeric references and escapes", () => {
    const md = "x &#65; \\* y\n";
    expect(selectRendered(md, "A")).toBe("&#65;");
    expect(selectRendered(md, "* y")).toBe("\\* y");
  });

  test("soft line break inside a blockquote skips the `> ` prefix", () => {
    const md = "> first line\n> second line\n";
    expect(selectRendered(md, "line\nsecond")).toBe("line\n> second");
  });

  test("fenced code block", () => {
    const md = "text\n\n```js\nconst a = 1;\nconst b = 2;\n```\n";
    expect(selectRendered(md, "b = 2")).toBe("b = 2");
    expect(selectRendered(md, "1;\nconst")).toBe("1;\nconst");
  });

  test("indented fenced code inside a list strips the indentation", () => {
    const md = "- item\n\n  ```\n  one\n    two\n  ```\n";
    expect(selectRendered(md, "two")).toBe("two");
    expect(selectRendered(md, "  two")).toBe("  two");
  });

  test("fenced code inside a blockquote skips the `> ` prefix", () => {
    const md = "> ```\n> a > b\n>   c\n> ```\n";
    expect(selectRendered(md, "a > b")).toBe("a > b");
    expect(selectRendered(md, "  c")).toBe("  c");
  });

  test("CRLF source", () => {
    const md = "first\r\nsecond &amp; third\r\n";
    expect(selectRendered(md, "second & third")).toBe("second &amp; third");
  });

  test("source -> rendered range for highlights", () => {
    const md = "a &amp; b\n";
    const [n] = textNodes(md);
    const start = md.indexOf("&amp;");
    expect(renderedRange(n.map!, start, start + 5)).toEqual({ from: 2, to: 3 });
  });

  test("table cells", () => {
    const md = "| h1 | h2 |\n|----|----|\n| c1 | `c 2` |\n";
    expect(selectRendered(md, "c1")).toBe("c1");
    expect(selectRendered(md, "c 2")).toBe("c 2");
  });
});
