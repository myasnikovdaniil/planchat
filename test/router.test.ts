import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type Config } from "../src/config.ts";
import { Hub, type Connection, type EventMsg } from "../src/hub.ts";
import { audienceAfterComment, parseMentions } from "../src/router.ts";
import type { Author } from "../src/store.ts";

const human: Author = { kind: "human", name: "alice" };
const sess = (name: string): Author => ({ kind: "session", name });

let root: string;
let clock: number;
let cfg: Config;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "planchat-router-"));
  writeFileSync(join(root, "plan.md"), "# Plan\n\nStep one: build it.\nStep two: ship it.\n");
  writeFileSync(join(root, "other.md"), "other file\n");
  clock = 1_000_000;
  cfg = { ...defaultConfig(), workspaces: [{ name: "w", root, include: ["**"], exclude: [] }], graceSeconds: 120 };
});

function hub(): Hub {
  const h = new Hub(cfg, { watch: false, now: () => clock });
  h.start();
  return h;
}

class FakeConn implements Connection {
  msgs: any[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(
    public session: string,
    public autoAck = true,
    private h?: Hub,
    public agent?: string,
  ) {}
  transport = "events" as const;
  send(msg: any) {
    this.msgs.push(msg);
    if (this.autoAck && msg.type === "event" && this.h) this.h.ack(this.session, msg.ws, msg.seq);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  events(): EventMsg[] {
    return this.msgs.filter((m) => m.type === "event");
  }
}

function attach(h: Hub, name: string, autoAck = true): FakeConn {
  const c = new FakeConn(name, autoAck, h);
  const r = h.connect(c, root);
  expect(r.ok).toBe(true);
  return c;
}

const anchorOn = (exact: string) => ({ exact });

describe("mentions and audience", () => {
  test("parse @names, skip emails", () => {
    expect(parseMentions("@a please, and @b-2. mail me at x@y.z")).toEqual(["a", "b-2"]);
  });
  test("a human comment with new names replaces the audience; repeating old names does not", () => {
    expect(audienceAfterComment("*", "@a do it")).toEqual(["a"]);
    expect(audienceAfterComment(["a", "b"], "@a only you")).toBeUndefined();
    expect(audienceAfterComment(["a"], "@b now")).toEqual(["b"]);
    expect(audienceAfterComment(["a"], "no mention")).toBeUndefined();
  });
});

describe("routing", () => {
  test("a thread without addressee reaches every subscriber of the file; sessions never get their own or each other's actions", () => {
    const h = hub();
    const a = attach(h, "a");
    const b = attach(h, "b");
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "why one?" });
    expect(a.events().length).toBe(1);
    expect(b.events().length).toBe(1);
    w.reply(sess("a"), t.id, "@b because");
    w.react(sess("a"), t.id, "do", true);
    expect(a.events().length).toBe(1);
    expect(b.events().length).toBe(1);
    // signal reactions from a human do not wake anyone
    w.react(human, t.id, "hold", true);
    expect(a.events().length).toBe(1);
  });

  test("subscription globs limit what a session hears", () => {
    const h = hub();
    const a = attach(h, "a");
    h.subscribe("a", "w", ["other.md"]);
    h.ws("w").createThread(human, { file: "plan.md", anchor: anchorOn("Step two"), body: "?" });
    expect(a.events().length).toBe(0);
  });

  test("comment @a, then do -> only a; b claiming first is refused", () => {
    const h = hub();
    const a = attach(h, "a");
    const b = attach(h, "b");
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "@a rename this" });
    w.react(human, t.id, "do", true);
    expect(a.events().map((e) => e.line.includes('reacted "do"') || e.line.includes("commented"))).toEqual([true, true]);
    expect(b.events().length).toBe(0);
    expect(() => w.claim(sess("b"), t.id)).toThrow(/audience/);
    expect(w.claim(sess("a"), t.id).ok).toBe(true);
    expect(w.state.thread(t.id)!.comments[0].reactions.some((r) => r.kind === "seen" && r.author.name === "a")).toBe(true);
  });

  test("first claim wins, the second session gets claimed_by", () => {
    const h = hub();
    attach(h, "a");
    attach(h, "b");
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "fix" });
    w.react(human, t.id, "do", true);
    expect(w.claim(sess("a"), t.id).ok).toBe(true);
    expect(w.claim(sess("b"), t.id)).toMatchObject({ ok: false, claimed_by: "a" });
  });

  test("claim by a, a offline past grace -> stale but kept, b hears nothing; human release -> delivered again", () => {
    const h = hub();
    const a = attach(h, "a");
    const b = attach(h, "b");
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "fix" });
    w.react(human, t.id, "do", true);
    w.claim(sess("a"), t.id);
    const bBefore = b.events().length;
    h.disconnect(a);
    clock += 121_000;
    const view = h.threadView(w, w.thread(t.id));
    expect(view.claim?.session).toBe("a");
    expect(view.claimStale).toBe(true);
    w.reply(human, t.id, "any news?");
    expect(b.events().length).toBe(bBefore);
    w.release(human, t.id);
    const last = b.events().at(-1)!;
    expect(last.line).toContain("released the claim");
    expect(last.thread).toBe(t.id);
    // a gets it too once it reconnects
    const a2 = attach(h, "a");
    expect(a2.events().some((e) => e.line.includes("released the claim"))).toBe(true);
  });

  test("claim not stale while the owner is online or within grace", () => {
    const h = hub();
    const a = attach(h, "a");
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "fix" });
    w.claim(sess("a"), t.id);
    clock += 500_000;
    expect(h.threadView(w, w.thread(t.id)).claimStale).toBe(false);
    h.disconnect(a);
    clock += 60_000;
    expect(h.threadView(w, w.thread(t.id)).claimStale).toBe(false);
  });

  test("explicit release by the owner offers the thread to the rest of the audience", () => {
    const h = hub();
    const a = attach(h, "a");
    const b = attach(h, "b");
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "fix" });
    w.claim(sess("a"), t.id);
    const aBefore = a.events().length;
    w.release(sess("a"), t.id);
    expect(a.events().length).toBe(aBefore);
    expect(b.events().at(-1)!.line).toContain("gave the thread back");
  });

  test("two sessions that reply and release do not bounce the thread between each other", () => {
    const h = hub();
    const a = attach(h, "a");
    const b = attach(h, "b");
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "thoughts?" });
    w.claim(sess("a"), t.id);
    w.reply(sess("a"), t.id, "a: my take");
    w.release(sess("a"), t.id);
    expect(b.events().at(-1)!.line).toContain("gave the thread back");
    const aCount = a.events().length;
    w.claim(sess("b"), t.id);
    w.reply(sess("b"), t.id, "b: agree");
    w.release(sess("b"), t.id);
    expect(a.events().length).toBe(aCount); // a already answered the human
    // a new human comment opens the round again
    w.reply(human, t.id, "and now?");
    expect(a.events().length).toBe(aCount + 1);
  });

  test("claim by a, resolve with `do` standing -> no redelivery; claim on a resolved thread is refused", () => {
    const h = hub();
    const a = attach(h, "a");
    const b = attach(h, "b");
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "fix" });
    w.react(human, t.id, "do", true);
    w.claim(sess("a"), t.id);
    const counts = [a.events().length, b.events().length];
    w.resolve(sess("a"), t.id);
    expect(w.thread(t.id).claim).toBeNull();
    expect([a.events().length, b.events().length]).toEqual(counts);
    expect(() => w.claim(sess("b"), t.id)).toThrow(/resolved/);
    // reconnecting does not bring it back either
    h.disconnect(b);
    const b2 = attach(h, "b");
    expect(b2.events().length).toBe(0);
  });

  test("a session resolves only what it claimed", () => {
    const h = hub();
    attach(h, "a");
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "fix" });
    expect(() => w.resolve(sess("a"), t.id)).toThrow(/claimed/);
    w.resolve(human, t.id);
    expect(w.thread(t.id).status).toBe("resolved");
  });
});

describe("at-least-once delivery", () => {
  test("`do` while planchat events is not connected (re-arm window) -> delivered exactly once on connect", () => {
    const h = hub();
    const a = attach(h, "a");
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "fix" });
    h.disconnect(a);
    w.react(human, t.id, "do", true);
    const a2 = attach(h, "a");
    const dos = a2.events().filter((e) => e.line.includes('reacted "do"'));
    expect(dos.length).toBe(1);
    // a third connection after the ack gets nothing new
    h.disconnect(a2);
    const a3 = attach(h, "a");
    expect(a3.events().length).toBe(0);
  });

  test("daemon restart between event and ack -> same event delivered again with the same id", () => {
    let h = hub();
    const a = attach(h, "a", false); // never acks
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "fix" });
    w.react(human, t.id, "do", true);
    const first = a.events().map((e) => e.id);
    expect(first.length).toBe(2);
    h.stop();

    h = hub();
    const a2 = attach(h, "a");
    expect(a2.events().map((e) => e.id)).toEqual(first);
    h.stop();

    h = hub();
    const a3 = attach(h, "a");
    expect(a3.events().length).toBe(0);
    h.stop();
  });

  test("duplicate online name is refused unless it is the same Claude session", () => {
    const h = hub();
    const one = new FakeConn("a", true, h, "claude:1");
    expect(h.connect(one, root).ok).toBe(true);
    expect(h.connect(new FakeConn("a", true, h, "claude:2"), root)).toMatchObject({ ok: false });
    const again = new FakeConn("a", true, h, "claude:1");
    expect(h.connect(again, root).ok).toBe(true);
    expect(one.closed?.code).toBe(4000);
  });

  test("first connection subscribes to the workspace containing cwd; a fresh subscription has no backlog", () => {
    const h = hub();
    const w = h.ws("w");
    w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "old" });
    const a = attach(h, "a");
    expect(a.msgs[0]).toMatchObject({ type: "hello", subscriptions: [{ ws: "w", globs: ["**"] }] });
    expect(a.events().length).toBe(0);
  });
});

describe("anchors through the workspace", () => {
  test("selection made on an older version translates via its snapshot; without the snapshot -> 409", () => {
    writeFileSync(join(root, "abc.txt"), "abc");
    const h = hub();
    const w = h.ws("w");
    const seen = w.view("abc.txt");
    writeFileSync(join(root, "abc.txt"), "xabc");
    const t = w.createThread(human, { file: "abc.txt", anchor: { start: 1, end: 2, baseHash: seen.hash }, body: "b?" });
    expect([t.anchor.start, t.anchor.end, t.anchor.exact]).toEqual([2, 3, "b"]);
    expect(() =>
      w.createThread(human, { file: "abc.txt", anchor: { start: 1, end: 2, baseHash: "0".repeat(64) }, body: "b?" }),
    ).toThrow(expect.objectContaining({ status: 409 }));
  });

  test("{exact} with several occurrences needs nth", () => {
    writeFileSync(join(root, "dup.txt"), "x y x");
    const h = hub();
    const w = h.ws("w");
    expect(() => w.createThread(human, { file: "dup.txt", anchor: { exact: "x" }, body: "?" })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(w.createThread(human, { file: "dup.txt", anchor: { exact: "x", nth: 1 }, body: "?" }).anchor.start).toBe(4);
  });

  test("file edited while the daemon is down: re-anchored on start from the snapshot", () => {
    let h = hub();
    const t = h.ws("w").createThread(human, { file: "plan.md", anchor: anchorOn("Step two"), body: "?" });
    h.stop();
    writeFileSync(join(root, "plan.md"), "# Plan\n\nIntro.\n\nStep one: build it.\nStep two: ship it.\n");
    h = hub();
    const a = h.ws("w").thread(t.id).anchor;
    expect(a.state).toBe("moved");
    expect(a.exact).toBe("Step two");
    h.stop();
  });

  test("paths outside the workspace are refused", () => {
    const h = hub();
    const w = h.ws("w");
    for (const p of ["../etc/passwd", "/etc/passwd", ".planchat/events.jsonl", "a/../plan.md"]) {
      expect(() => w.read(p)).toThrow(expect.objectContaining({ status: 404 }));
    }
  });
});

describe("what the agent changed", () => {
  test("claim, edit, reply: the reply carries the change; resolve after a second edit carries its own", () => {
    const h = hub();
    attach(h, "a");
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step two"), body: "@a ship faster" });
    w.claim(sess("a"), t.id);
    writeFileSync(join(root, "plan.md"), "# Plan\n\nStep one: build it.\nStep two: ship it today.\n");
    w.reply(sess("a"), t.id, "done");
    const c = w.thread(t.id).comments[1];
    expect(c.change).toBeDefined();
    const d = h.diff(w, c.change!.from, c.change!.to);
    expect([d.added, d.removed]).toEqual([1, 1]);
    expect(d.hunks[0].lines.filter((l) => l.t !== " ").map((l) => l.t + l.s)).toEqual(["-Step two: ship it.", "+Step two: ship it today."]);
    expect(h.threadView(w, w.thread(t.id)).comments[1].change!.stats).toEqual({ added: 1, removed: 1 });

    // a human reply records no change; the next session step starts from there
    w.reply(human, t.id, "also mention build");
    writeFileSync(join(root, "plan.md"), "# Plan\n\nStep one: build it fast.\nStep two: ship it today.\n");
    w.resolve(sess("a"), t.id);
    const r = w.thread(t.id).resolved!;
    expect(r.by.name).toBe("a");
    expect(h.diff(w, r.change!.from, r.change!.to).hunks[0].lines.filter((l) => l.t === "+").map((l) => l.s)).toEqual(["Step one: build it fast."]);
  });

  test("a reply without a file change records none; human edits never count as a session change", () => {
    const h = hub();
    attach(h, "a");
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "?" });
    w.reply(sess("a"), t.id, "just an answer");
    expect(w.thread(t.id).comments[1].change).toBeUndefined();
    writeFileSync(join(root, "plan.md"), "# Plan v2\n\nStep one: build it.\nStep two: ship it.\n");
    w.reply(human, t.id, "I renamed the title");
    expect(w.thread(t.id).comments[2].change).toBeUndefined();
  });

  test("versions a change refers to survive snapshot rotation and a restart", () => {
    cfg = { ...cfg, snapshots: 2 };
    let h = hub();
    attach(h, "a");
    let w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: anchorOn("Step one"), body: "?" });
    w.claim(sess("a"), t.id);
    writeFileSync(join(root, "plan.md"), "# Plan\n\nStep one: build it well.\nStep two: ship it.\n");
    w.reply(sess("a"), t.id, "edited");
    const ch = w.thread(t.id).comments[1].change!;
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, "plan.md"), `# Plan ${i}\n\nStep one: build it well.\nStep two: ship it.\n`);
      w.reanchorFile("plan.md");
    }
    expect(w.snapshots.get(ch.from)).not.toBeNull();
    h.stop();
    h = hub();
    w = h.ws("w");
    expect(h.diff(w, ch.from, ch.to).added).toBe(1);
    h.stop();
  });
});

