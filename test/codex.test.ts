import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type Config } from "../src/config.ts";
import { Hub } from "../src/hub.ts";
import { PlanchatClient } from "../src/client.ts";
import { PlanchatServer } from "../src/server.ts";
import { sha256, type Author } from "../src/store.ts";
import type { CodexQueue } from "../src/codex.ts";

const human: Author = { kind: "human", name: "alice" };
const THREAD = "3f6c1a52-8b0e-4d2a-9c71-5e2d4b8a0f13";

let root: string;
let home: string;
let cfg: Config;
let calls: { thread: string; message: string }[];
let failNext: number;
const fake: CodexQueue = async (thread, message) => {
  if (failNext > 0) {
    failNext--;
    return { ok: false, error: "exit 1: daemon down" };
  }
  calls.push({ thread, message });
  return { ok: true };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "planchat-codex-"));
  home = mkdtempSync(join(tmpdir(), "planchat-codex-home-"));
  writeFileSync(join(root, "plan.md"), "# Plan\n\nStep one: build it.\nStep two: ship it.\n");
  cfg = { ...defaultConfig(), workspaces: [{ name: "w", root, include: ["**"], exclude: [] }] };
  calls = [];
  failNext = 0;
});

const until = async (cond: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await Bun.sleep(10);
  }
};

function hub(): Hub {
  const h = new Hub(cfg, { watch: false, attachmentsPath: join(home, "attachments.json"), codexQueue: fake });
  h.start();
  return h;
}

describe("codex delivery", () => {
  test("attach subscribes by cwd; a human comment is queued into the thread and acknowledged", async () => {
    const h = hub();
    const r = h.attachCodex("cx", THREAD, root);
    expect(r.subscriptions).toEqual([{ ws: "w", globs: ["**"] }]);
    expect(h.sessions().find((s) => s.name === "cx")).toMatchObject({ online: true, transport: "codex" });
    const w = h.ws("w");
    const t = w.createThread(human, { file: "plan.md", anchor: { exact: "Step two" }, body: "@cx ship today?" });
    await until(() => calls.length === 1);
    expect(calls[0].thread).toBe(THREAD);
    expect(calls[0].message).toContain(`thread=${t.id}`);
    expect(calls[0].message).toContain("user-text: @cx ship today?");
    expect(calls[0].message).toContain("planchat-codex skill");
    await until(() => w.delivery.subs.get("cx")!.cursor === w.head);
    h.stop();
  });

  test("a failed codex queue is retried, nothing is acknowledged until it succeeds, waiting events go out in one message", async () => {
    const h = hub();
    h.attachCodex("cx", THREAD, root);
    const w = h.ws("w");
    failNext = 1;
    const t = w.createThread(human, { file: "plan.md", anchor: { exact: "Step one" }, body: "first" });
    w.reply(human, t.id, "second");
    w.react(human, t.id, "do", true);
    expect(w.delivery.subs.get("cx")!.cursor).toBe(0);
    await until(() => calls.length >= 1, 5000);
    // the first failed batch was retried together with everything that came meanwhile
    const all = calls.map((c) => c.message).join("\n");
    expect(all).toContain("user-text: first");
    expect(all).toContain("user-text: second");
    expect(all).toContain('reacted "do"');
    expect(calls.length).toBeLessThanOrEqual(2);
    await until(() => w.delivery.subs.get("cx")!.cursor === w.head);
    h.stop();
  });

  test("attachment survives a daemon restart; events from while it was down arrive once", async () => {
    let h = hub();
    h.attachCodex("cx", THREAD, root);
    h.stop();
    // something happens while the daemon is down: replay it by writing through a hub without attachments
    const offline = new Hub(cfg, { watch: false, codexQueue: async () => ({ ok: false }) });
    offline.start();
    offline.ws("w").createThread(human, { file: "plan.md", anchor: { exact: "Step two" }, body: "while down" });
    offline.stop();
    h = hub();
    await until(() => calls.some((c) => c.message.includes("while down")));
    expect(calls.filter((c) => c.message.includes("while down")).length).toBe(1);
    expect(h.sessions().find((s) => s.name === "cx")?.online).toBe(true);
    h.stop();
  });

  test("detach stops delivery and forgets the attachment", async () => {
    let h = hub();
    h.attachCodex("cx", THREAD, root);
    expect(h.detach("cx")).toBe(true);
    h.ws("w").createThread(human, { file: "plan.md", anchor: { exact: "Step one" }, body: "after detach" });
    await Bun.sleep(50);
    expect(calls.length).toBe(0);
    h.stop();
    h = hub();
    expect(h.sessions().find((s) => s.name === "cx")?.online).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "attachments.json"), "utf8"))).toEqual({});
    h.stop();
  });

  test("bad thread ids are refused", () => {
    const h = hub();
    expect(() => h.attachCodex("cx", "not-a-uuid; rm -rf /", root)).toThrow(/bad codex thread/);
    h.stop();
  });
});

describe("codex through the HTTP API and a real binary", () => {
  let server: PlanchatServer;
  afterEach(() => server?.stop());

  test("CLI calls from the Codex thread are the attached session; the daemon runs the configured codex binary", async () => {
    const log = join(home, "codex-calls.log");
    const bin = join(home, "fake-codex");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
    chmodSync(bin, 0o755);
    const TOKEN = "tok";
    server = new PlanchatServer(
      { ...cfg, port: 0, tokens: { alice: sha256(TOKEN) }, codexBin: bin },
      { port: 0, lan: null, auth: true, persist: false, quiet: true, configFile: join(home, "config.json") },
    );
    await server.start();
    const url = `http://127.0.0.1:${server.port}`;
    const fromCodex = new PlanchatClient({ url, token: TOKEN, agent: `codex:${THREAD}` });
    // not attached yet: a mutation from the Codex shell is refused, not posted as the human
    await expect(fromCodex.createThread({ ws: "w", file: "plan.md", anchor: { exact: "Step one" }, body: "x" })).rejects.toMatchObject({ code: "session_unknown" });
    const r = await fromCodex.attach({ kind: "codex", session: "cx", cwd: root });
    expect(r.thread).toBe(THREAD);
    const asHuman = new PlanchatClient({ url, token: TOKEN });
    const t = await asHuman.createThread({ ws: "w", file: "plan.md", anchor: { exact: "Step two" }, body: "@cx please look" });
    await until(() => {
      try {
        return readFileSync(log, "utf8").includes(t.id);
      } catch {
        return false;
      }
    });
    expect(readFileSync(log, "utf8")).toContain(`queue --thread ${THREAD} --message [planchat] alice commented on plan.md:4`);
    // now the Codex shell acts as cx without --session
    expect((await fromCodex.claim(t.id)).ok).toBe(true);
    const v = await fromCodex.reply(t.id, "on it");
    expect(v.comments.at(-1)!.author).toEqual({ kind: "session", name: "cx" });
    expect(JSON.parse(readFileSync(join(home, "attachments.json"), "utf8"))).toEqual({ cx: { kind: "codex", thread: THREAD, cwd: root } });
  });
});
