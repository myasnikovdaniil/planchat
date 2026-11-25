import { describe, expect, test, beforeEach } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, SnapshotStore, sha256, type StoredEvent } from "../src/store.ts";
import { State } from "../src/state.ts";
import { makeAnchor } from "../src/anchor.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "planchat-store-"));
});

const human = { kind: "human" as const, name: "alice" };

function reopen(): { log: EventLog; events: StoredEvent[]; tornPath?: string } {
  const log = new EventLog(dir);
  const { events, report } = log.open();
  return { log, events, tornPath: report.tornPath };
}

describe("EventLog recovery", () => {
  test("torn write without newline: restart, new record, restart -> both records kept, tail in .torn-*", () => {
    let { log } = reopen();
    log.append({ type: "x", author: human, n: 1 });
    log.close();
    appendFileSync(join(dir, "events.jsonl"), '{"id":"partial","seq":2,"ty'); // crash mid-write

    let r = reopen();
    expect(r.events.map((e) => e.n)).toEqual([1]);
    expect(r.tornPath).toBeDefined();
    expect(readFileSync(r.tornPath!, "utf8")).toBe('{"id":"partial","seq":2,"ty');
    const second = r.log.append({ type: "x", author: human, n: 2 });
    expect(second.seq).toBe(2);
    r.log.close();

    r = reopen();
    expect(r.events.map((e) => e.n)).toEqual([1, 2]);
    expect(r.tornPath).toBeUndefined();
    r.log.close();
    expect(readdirSync(dir).filter((f) => f.includes(".torn-")).length).toBe(1);
  });

  test('broken line that ends in a newline: {"id":1}\\n{"id":\\n', () => {
    writeFileSync(join(dir, "events.jsonl"), '{"id":1}\n{"id":\n');
    let r = reopen();
    expect(r.events.length).toBe(1);
    expect(readFileSync(r.tornPath!, "utf8")).toBe('{"id":\n');
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toBe('{"id":1}\n');
    r.log.append({ type: "x", author: human, n: 2 });
    r.log.close();
    r = reopen();
    expect(r.events.length).toBe(2);
    expect(r.events[1].n).toBe(2);
    expect(r.events[1].seq).toBe(2);
    r.log.close();
  });

  test("seq is monotonic across restarts", () => {
    let { log } = reopen();
    for (let i = 0; i < 3; i++) log.append({ type: "x", author: human });
    log.close();
    const r = reopen();
    expect(r.log.append({ type: "x", author: human }).seq).toBe(4);
    r.log.close();
  });

  test("replay gives the same state as live application", () => {
    const text = "line one\nline two\n";
    const anchor = makeAnchor("a.md", text, 5, 8, sha256(text));
    const { log } = reopen();
    const live = new State();
    const push = (e: Record<string, unknown> & { type: string }) => live.apply(log.append({ author: human, ...e }));
    push({ type: "thread.create", thread: "T1", anchor, body: "why?", audience: "*" });
    push({ type: "comment.add", thread: "T1", comment: "C1", body: "@a look", audience: ["a"] });
    push({ type: "reaction.set", thread: "T1", target: "C1", kind: "do" });
    push({ type: "thread.claim", thread: "T1", session: "a" });
    push({ type: "reaction.set", thread: "T1", target: "T1", kind: "seen", author: { kind: "session", name: "a" } });
    push({ type: "comment.edit", thread: "T1", comment: "C1", body: "@a look again" });
    push({ type: "anchor.update", thread: "T1", anchor: { ...anchor, start: 6, end: 9, state: "moved" } });
    push({ type: "thread.resolve", thread: "T1" });
    push({ type: "thread.release", thread: "T1", reason: "resolved" });
    log.close();

    const r = reopen();
    const replayed = new State();
    for (const e of r.events) replayed.apply(e);
    r.log.close();
    expect(JSON.parse(JSON.stringify([...replayed.threads.values()]))).toEqual(
      JSON.parse(JSON.stringify([...live.threads.values()])),
    );
    const t = replayed.thread("T1")!;
    expect(t.status).toBe("resolved");
    expect(t.claim).toBeNull();
    expect(t.audience).toEqual(["a"]);
    expect(t.comments[1].body).toBe("@a look again");
    expect(t.comments[1].reactions.map((x) => x.kind)).toEqual(["do"]);
    expect(t.anchor.state).toBe("moved");
  });
});

describe("SnapshotStore", () => {
  test("keeps the last N versions per file and drops unreferenced blobs", () => {
    const s = new SnapshotStore(join(dir, "snapshots"), 2);
    const h1 = s.put("a.md", "v1");
    const h2 = s.put("a.md", "v2");
    s.put("b.md", "v1"); // shares the blob with a.md v1
    const h3 = s.put("a.md", "v3");
    expect(s.versions("a.md")).toEqual([h2, h3]);
    expect(s.get(h1)).toBe("v1"); // still referenced by b.md
    s.put("b.md", "w2");
    s.put("b.md", "w3");
    expect(existsSync(join(dir, "snapshots", h1))).toBe(false);
    expect(s.get(h2)).toBe("v2");
  });

  test("index survives a restart", () => {
    const a = new SnapshotStore(join(dir, "snapshots"), 5);
    const h = a.put("x", "content");
    const b = new SnapshotStore(join(dir, "snapshots"), 5);
    expect(b.versions("x")).toEqual([h]);
    expect(b.get(h)).toBe("content");
  });
});
