import { describe, expect, test } from "bun:test";
import {
  findByQuote,
  lineRange,
  makeAnchor,
  mapRange,
  quoteAt,
  rangeOfExact,
  reanchor,
  translateSelection,
} from "../src/anchor.ts";
import { sha256 } from "../src/store.ts";

const anchorOn = (text: string, exact: string, nth = 0) => {
  const r = rangeOfExact(text, exact, nth)!;
  return makeAnchor("f.txt", text, r.start, r.end, sha256(text));
};

describe("mapRange", () => {
  test("insert before the anchor moves it", () => {
    const old = "hello world\nanchor here\n";
    const neu = "new line\nhello world\nanchor here\n";
    const a = rangeOfExact(old, "anchor")!;
    const r = mapRange(old, neu, a.start, a.end);
    expect(r.state).toBe("moved");
    expect(neu.slice(r.start, r.end)).toBe("anchor");
  });

  test("change elsewhere after the anchor keeps it ok", () => {
    const old = "alpha beta gamma";
    const neu = "alpha beta gamma delta";
    const a = rangeOfExact(old, "beta")!;
    expect(mapRange(old, neu, a.start, a.end)).toEqual({ start: a.start, end: a.end, state: "ok" });
  });

  test("edit inside the anchor marks it edited", () => {
    const old = "The quick brown fox jumps.";
    const neu = "The quick red fox jumps.";
    const a = rangeOfExact(old, "quick brown fox")!;
    const r = mapRange(old, neu, a.start, a.end);
    expect(r.state).toBe("edited");
    expect(neu.slice(r.start, r.end)).toBe("quick red fox");
  });

  test("insert touching the edges stays outside the range", () => {
    const old = "xx abc yy";
    const neu = "xx >abc< yy";
    const a = rangeOfExact(old, "abc")!;
    const r = mapRange(old, neu, a.start, a.end);
    expect(r.state).toBe("moved");
    expect(neu.slice(r.start, r.end)).toBe("abc");
  });

  test("replacing exactly the anchored text keeps the range on the new text (edited)", () => {
    const old = "export function add(a, b) {}";
    const neu = "export function sum(a, b) {}";
    const a = rangeOfExact(old, "add")!;
    const r = mapRange(old, neu, a.start, a.end);
    expect(r.state).toBe("edited");
    expect(neu.slice(r.start, r.end)).toBe("sum");
  });

  test("replacing a sentence that holds the anchor, together with its neighbours, orphans it", () => {
    const old = "Intro. The anchored words sit here. Outro.";
    const neu = "Intro. Completely different text now stands. Outro.";
    const a = rangeOfExact(old, "anchored")!;
    expect(mapRange(old, neu, a.start, a.end).state).toBe("orphaned");
  });

  test("deleting the anchored text orphans it", () => {
    const old = "keep this. remove this sentence. keep that.";
    const neu = "keep this. keep that.";
    const a = rangeOfExact(old, "remove this sentence.")!;
    const r = mapRange(old, neu, a.start, a.end);
    expect(r.state).toBe("orphaned");
    expect(r.reason).toBe("deleted");
  });

  test("deleting a function with `return 1` orphans, not moves, when another function has the same line", () => {
    const old = [
      "function first() {",
      "  const a = compute();",
      "  return 1",
      "}",
      "",
      "function second() {",
      "  log('x');",
      "  return 1",
      "}",
      "",
    ].join("\n");
    const neu = ["function second() {", "  log('x');", "  return 1", "}", ""].join("\n");
    const a = rangeOfExact(old, "return 1", 0)!;
    const r = mapRange(old, neu, a.start, a.end);
    expect(r.state).toBe("orphaned");
  });

  test("P+P -> P with the anchor in the first block is orphaned (ambiguous)", () => {
    const P = "paragraph with a sentence that repeats.\n";
    const old = P + P;
    const neu = P;
    const a = rangeOfExact(old, "a sentence", 0)!;
    const r = mapRange(old, neu, a.start, a.end);
    expect(r).toMatchObject({ state: "orphaned", reason: "ambiguous" });
  });

  test("characters outside the BMP keep the range on code point boundaries", () => {
    const old = "start 😀 middle 🚀 end";
    const neu = "start 😀😀 middle 🚀 end";
    const a = rangeOfExact(old, "🚀")!;
    const r = mapRange(old, neu, a.start, a.end);
    expect(r.state).toBe("moved");
    expect(neu.slice(r.start, r.end)).toBe("🚀");
  });

  test("editing one emoji to another inside the anchor does not split surrogates", () => {
    const old = "a 😀 b";
    const neu = "a 😁 b";
    const a = rangeOfExact(old, "😀")!;
    const r = mapRange(old, neu, a.start, a.end);
    // shared high surrogate survives, so the range is edited, and it is whole
    expect(r.state).toBe("edited");
    expect(neu.slice(r.start, r.end)).toBe("😁");
  });

  test("file emptied orphans the anchor", () => {
    const old = "abc";
    expect(mapRange(old, "", 0, 3).state).toBe("orphaned");
  });
});

describe("makeAnchor", () => {
  test("rejects empty ranges, including on an empty file", () => {
    expect(() => makeAnchor("f", "", 0, 0, sha256(""))).toThrow();
    expect(() => makeAnchor("f", "abc", 2, 2, sha256("abc"))).toThrow();
  });

  test("snaps a range that splits a surrogate pair", () => {
    const text = "x🚀y";
    const a = makeAnchor("f", text, 2, 3, sha256(text));
    expect(a.exact).toBe("🚀");
  });

  test("context is capped at 32 characters", () => {
    const text = "p".repeat(50) + "X" + "s".repeat(50);
    const q = quoteAt(text, 50, 51);
    expect(q.prefix.length).toBe(32);
    expect(q.suffix.length).toBe(32);
  });
});

describe("findByQuote (no snapshot)", () => {
  test("a unique quote with matching context is found", () => {
    const text = "one two three four five";
    const a = anchorOn(text, "three");
    const neu = "zero " + text;
    const r = findByQuote(neu, a, 0.75, a.start);
    expect(r.state).toBe("moved");
    expect(neu.slice(r.start, r.end)).toBe("three");
  });

  test("two identical occurrences with the same context are orphaned", () => {
    const block = "function x() {\n  return 1\n}\n";
    const text = block + block;
    const a = anchorOn(text, "return 1", 0);
    const r = findByQuote(text, a, 0.75, a.start);
    expect(r).toMatchObject({ state: "orphaned", reason: "multiple" });
  });

  test("quote gone -> orphaned", () => {
    const a = anchorOn("alpha beta", "beta");
    expect(findByQuote("alpha gamma", a, 0.75).reason).toBe("not-found");
  });

  test("quote present but context unrelated -> orphaned", () => {
    const a = anchorOn("the left side holds beta and the right side too", "beta");
    expect(findByQuote("completely different words then beta then more different words", a, 0.75).reason).toBe("context");
  });

  test("empty file -> orphaned", () => {
    const a = anchorOn("abc", "b");
    expect(findByQuote("", a, 0.75).state).toBe("orphaned");
  });
});

describe("reanchor", () => {
  test("uses the snapshot when there is one and refreshes the quote", () => {
    const old = "aaa target bbb";
    const neu = "zzz aaa target bbb";
    const a = anchorOn(old, "target");
    const b = reanchor(a, old, neu, sha256(neu), 0.75);
    expect(b.state).toBe("moved");
    expect(b.fileHash).toBe(sha256(neu));
    expect(neu.slice(b.start, b.end)).toBe("target");
    expect(b.prefix).toBe("zzz aaa ");
  });

  test("edited stays edited after a later plain move", () => {
    const v1 = "x the target y";
    const v2 = "x the tarGet y";
    const v3 = "prefix x the tarGet y";
    let a = anchorOn(v1, "the target");
    a = reanchor(a, v1, v2, sha256(v2), 0.75);
    expect(a.state).toBe("edited");
    a = reanchor(a, v2, v3, sha256(v3), 0.75);
    expect(a.state).toBe("edited");
    expect(v3.slice(a.start, a.end)).toBe("the tarGet");
  });

  test("orphaned anchors stay orphaned", () => {
    const old = "abc def";
    const a = { ...anchorOn(old, "def"), state: "orphaned" as const, reason: "deleted" as const };
    expect(reanchor(a, old, "def abc def", sha256("def abc def"), 0.75)).toBe(a);
  });
});

describe("translateSelection (baseHash)", () => {
  test("[1,2) in `abc` seen by the UI, file is now `xabc` -> [2,3) on `b`", () => {
    expect(translateSelection("abc", "xabc", 1, 2)).toEqual({ start: 2, end: 3 });
  });

  test("selection whose text changed meanwhile is refused", () => {
    expect(translateSelection("abc", "aXc", 1, 2)).toBeNull();
  });
});

describe("lineRange", () => {
  test("1-based lines, mixed endings", () => {
    const text = "a\nb\r\nc\rd";
    expect(lineRange(text, 0, 1)).toEqual({ from: 1, to: 1 });
    expect(lineRange(text, 2, 6)).toEqual({ from: 2, to: 3 });
    expect(lineRange(text, 7, 8)).toEqual({ from: 4, to: 4 });
  });
});
