// The real CLI as separate processes: planchat serve, planchat events, operations.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const home = mkdtempSync(join(tmpdir(), "planchat-cli-home-"));
const root = mkdtempSync(join(tmpdir(), "planchat-cli-ws-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, PLANCHAT_HOME: home, PLANCHAT_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_SESSION_ID: "", CLAUDECODE: "", CODEX_THREAD_ID: "" };
delete (env as any).PLANCHAT_SESSION;

async function planchat(args: string[], input?: string) {
  const p = Bun.spawn([process.execPath, CLI, ...args], { env, cwd: root, stdin: input !== undefined ? new Blob([input]) : "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out.trim(), err: err.trim() };
}

class Lines {
  lines: string[] = [];
  constructor(readonly proc: Subprocess<"ignore", "pipe", "pipe">) {
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk);
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          this.lines.push(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
    })();
  }
  async waitFor(pred: (l: string) => boolean, ms = 5000): Promise<string> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.lines.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timeout; lines: ${JSON.stringify(this.lines)}`);
      await Bun.sleep(20);
    }
  }
}

function events(session: string) {
  return new Lines(Bun.spawn([process.execPath, CLI, "events", "--session", session, "--cwd", root], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
}

let serve: Subprocess;
let token = "";

beforeAll(async () => {
  writeFileSync(join(root, "plan.md"), "# Plan\n\nStep one: build it.\nStep two: ship it.\n");
  const t = await planchat(["token", "add", "alice", "--save"]);
  expect(t.code).toBe(0);
  token = t.out;
  expect((await planchat(["ws", "add", "w", root])).code).toBe(0);
  serve = Bun.spawn([process.execPath, CLI, "serve", "--port", String(port)], { env, stdout: "ignore", stderr: "pipe" });
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
    if (r?.ok) return;
    await Bun.sleep(50);
  }
  throw new Error("daemon did not start");
});

afterAll(() => {
  serve?.kill();
});

describe("CLI end to end", () => {
  test("comment -> planchat events line -> claim/reply/resolve; restart of planchat events gets no duplicates", async () => {
    const a = events("a");
    await a.waitFor((l) => l.startsWith("[planchat] connected as a"));
    const created = await planchat(["create", join(root, "plan.md"), "@a please check", "--exact", "Step two", "--json"]);
    expect(created.code).toBe(0);
    const id = JSON.parse(created.out).id as string;
    const line = await a.waitFor((l) => l.includes(`thread=${id}`));
    expect(line).toContain("alice commented on plan.md:4");
    expect(line).toContain("user-text: @a please check");

    const claim = await planchat(["--session", "a", "claim", id]);
    expect(claim.code).toBe(0);
    const reply = await planchat(["--session", "a", "reply", id, "-"], "line one\nline two");
    expect(reply.code).toBe(0);
    const got = await planchat(["get", id]);
    expect(got.out).toContain("session:a");
    expect(got.out).toContain("  line two");
    expect(got.out).toContain("seen:a");

    // b is not in the audience
    const b = await planchat(["--session", "b", "claim", id]);
    expect(b.code).not.toBe(0);

    expect((await planchat(["--session", "a", "resolve", id])).code).toBe(0);
    a.proc.kill();
    await a.proc.exited;

    // reconnect: the earlier event was acked, nothing comes again
    const a2 = events("a");
    await a2.waitFor((l) => l.startsWith("[planchat] connected as a"));
    expect(a2.lines.some((l) => l.includes("pending: 0"))).toBe(true);
    a2.proc.kill();
  });

  test("an event while planchat events is down arrives after it comes back", async () => {
    const a = events("a");
    await a.waitFor((l) => l.startsWith("[planchat] connected"));
    a.proc.kill();
    await a.proc.exited;
    const created = await planchat(["create", "plan.md", "anyone?", "--exact", "Step one", "--json"]);
    const id = JSON.parse(created.out).id;
    await planchat(["react", id, "do"]);
    const a2 = events("a");
    await a2.waitFor((l) => l.includes(`thread=${id}`) && l.includes('reacted "do"'));
    expect(a2.lines.filter((l) => l.includes(`thread=${id}`)).length).toBe(2);
    a2.proc.kill();
  });

  test("duplicate session name is refused with an error line and exit 2", async () => {
    const a = events("dup");
    await a.waitFor((l) => l.startsWith("[planchat] connected"));
    const p = Bun.spawn([process.execPath, CLI, "events", "--session", "dup", "--cwd", root], { env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(2);
    expect(out).toContain("[planchat] error: session name dup is already connected");
    a.proc.kill();
  });

  test("inside a Claude shell, a mutation without --session is refused", async () => {
    const p = Bun.spawn([process.execPath, CLI, "create", "plan.md", "x", "--exact", "Step one"], {
      env: { ...env, CLAUDE_CODE_SESSION_ID: "cc-unknown" },
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(p.stderr).text();
    expect(await p.exited).not.toBe(0);
    expect(err).toContain("--session");
  });

  test("list shows threads", async () => {
    const r = await planchat(["list", "--status", "all"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[w] plan.md:");
  });
});
