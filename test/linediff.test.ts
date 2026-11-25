import { describe, expect, test } from "bun:test";
import { lineDiff } from "../src/linediff.ts";

const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

describe("lineDiff", () => {
  test("identical texts: no hunks", () => {
    expect(lineDiff("a\nb\n", "a\nb\n")).toEqual({ added: 0, removed: 0, hunks: [] });
  });

  test("one replaced line in the middle, 3 lines of context, line numbers on both sides", () => {
    const a = lines(10);
    const b = a.replace("line 5\n", "line five\n");
    const d = lineDiff(a, b);
    expect([d.added, d.removed]).toEqual([1, 1]);
    expect(d.hunks.length).toBe(1);
    const h = d.hunks[0];
    expect([h.oldStart, h.newStart]).toEqual([2, 2]);
    expect(h.lines.map((l) => `${l.t}${l.s}`)).toEqual([" line 2", " line 3", " line 4", "-line 5", "+line five", " line 6", " line 7", " line 8"]);
    expect(h.lines.find((l) => l.t === "-")!.old).toBe(5);
    expect(h.lines.find((l) => l.t === "+")!.new).toBe(5);
  });

  test("changes far apart give separate hunks, close ones merge", () => {
    const a = lines(30);
    const far = a.replace("line 3\n", "x\n").replace("line 25\n", "y\n");
    expect(lineDiff(a, far).hunks.length).toBe(2);
    const near = a.replace("line 3\n", "x\n").replace("line 8\n", "y\n");
    expect(lineDiff(a, near).hunks.length).toBe(1);
  });

  test("insertion at the top and deletion at the end", () => {
    const a = "b\nc\n";
    const d = lineDiff(a, "a\nb\n");
    expect([d.added, d.removed]).toEqual([1, 1]);
    expect(d.hunks[0].lines.map((l) => `${l.t}${l.s}`)).toEqual(["+a", " b", "-c"]);
  });

  test("CRLF lines are shown without the carriage return; last line without newline counts", () => {
    const d = lineDiff("a\r\nb", "a\r\nc");
    expect(d.hunks[0].lines.map((l) => `${l.t}${l.s}`)).toEqual([" a", "-b", "+c"]);
  });
});
