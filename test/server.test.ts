import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type Config } from "../src/config.ts";
import { PlanchatClient, streamEvents } from "../src/client.ts";
import { PlanchatServer } from "../src/server.ts";
import { sha256 } from "../src/store.ts";

let root: string;
let home: string;
let server: PlanchatServer;
const TOKEN = "test-token-123";

async function start(auth = true, extra: Partial<Config> = {}) {
  const cfg: Config = {
    ...defaultConfig(),
    port: 0,
    tokens: { alice: sha256(TOKEN) },
    workspaces: [{ name: "w", root, include: ["**"], exclude: [] }],
    debounceMs: 30,
    ...extra,
  };
  server = new PlanchatServer(cfg, { port: 0, lan: null, auth, persist: false, quiet: true, configFile: join(home, "config.json") });
  await server.start();
  return `http://127.0.0.1:${server.port}`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "planchat-srv-"));
  home = mkdtempSync(join(tmpdir(), "planchat-home-"));
  writeFileSync(join(root, "plan.md"), "# Plan\n\nStep one: build it.\nStep two: ship it.\n");
});
afterEach(() => server?.stop());

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await Bun.sleep(10);
  }
};

describe("auth, Host and Origin", () => {
  test("no token -> 401, wrong token -> 401, right token -> 200", async () => {
    const url = await start();
    expect((await fetch(`${url}/api/threads`)).status).toBe(401);
    expect((await fetch(`${url}/api/threads`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(`${url}/api/threads`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  test("POST with a foreign Origin -> 403, even with a valid token", async () => {
    const url = await start();
    const res = await fetch(`${url}/api/threads`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ file: "plan.md", anchor: { exact: "Step one" }, body: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("--no-auth still checks Origin and Host", async () => {
    const url = await start(false);
    const bad = await fetch(`${url}/api/threads`, { method: "POST", headers: { origin: "http://evil.example" }, body: "{}" });
    expect(bad.status).toBe(403);
    const rebinding = await fetch(`${url}/api/threads`, { headers: { host: `evil.example:${server.port}` } });
    expect(rebinding.status).toBe(403);
    expect((await fetch(`${url}/api/threads`)).status).toBe(200);
  });

  test("?token= on / sets an HttpOnly SameSite=Strict cookie and redirects", async () => {
    const url = await start();
    const res = await fetch(`${url}/?token=${TOKEN}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toMatch(/planchat_token=.*HttpOnly; SameSite=Strict/);
    const withCookie = await fetch(`${url}/api/me`, { headers: { cookie: `planchat_token=${TOKEN}` } });
    expect((await withCookie.json()).author).toEqual({ kind: "human", name: "alice" });
  });

  test("a Claude shell without a known session cannot mutate as a human", async () => {
    const url = await start();
    const c = new PlanchatClient({ url, token: TOKEN, agent: "claude:cc-1" });
    await expect(c.createThread({ ws: "w", file: "plan.md", anchor: { exact: "Step one" }, body: "x" })).rejects.toMatchObject({ code: "session_unknown" });
    const asHuman = new PlanchatClient({ url, token: TOKEN, agent: "claude:cc-1", asHuman: true });
    expect((await asHuman.createThread({ ws: "w", file: "plan.md", anchor: { exact: "Step one" }, body: "x" })).author.kind).toBe("human");
  });
});

describe("end to end over HTTP and WS", () => {
  test("human comment reaches `a` over the events socket; a claims, replies, the UI stream sees it", async () => {
    const url = await start();
    const human = new PlanchatClient({ url, token: TOKEN });
    const a = new PlanchatClient({ url, token: TOKEN, session: "a" });
    const lines: string[] = [];
    let hello: any = null;
    const stream = streamEvents(a, { session: "a", cwd: root, transport: "events" }, {
      hello: (h) => (hello = h),
      event: async (e) => void lines.push(e.line),
      fatal: (m) => lines.push("FATAL " + m),
    });
    await until(() => hello !== null);
    expect(hello.subscriptions).toEqual([{ ws: "w", globs: ["**"] }]);

    // UI stream
    const sse = await fetch(`${url}/api/stream?ws=w`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const reader = sse.body!.getReader();
    const seen: string[] = [];
    (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        seen.push(dec.decode(value));
      }
    })();

    const t = await human.createThread({ ws: "w", file: "plan.md", anchor: { exact: "Step two" }, body: "@a is this\nready?" });
    await until(() => lines.length === 1);
    expect(lines[0]).toContain("alice commented on plan.md:4");
    expect(lines[0]).toContain("«Step two»");
    expect(lines[0]).toContain("user-text: @a is this\\nready?");

    expect((await a.claim(t.id)).ok).toBe(true);
    await a.reply(t.id, "yes");
    await until(() => seen.join("").includes('"comment.add"'));
    expect(lines.length).toBe(1); // own actions never come back

    // duplicate name refused
    const dupLines: string[] = [];
    let fatal = "";
    const dup = streamEvents(a, { session: "a", cwd: root, transport: "events" }, {
      hello: () => {},
      event: async (e) => void dupLines.push(e.line),
      fatal: (m) => (fatal = m),
    });
    await until(() => fatal !== "");
    expect(fatal).toContain("already connected");
    dup.close();
    stream.close();
    reader.cancel();
  });

  test("file edit moves the anchor and the UI stream reports the change", async () => {
    const url = await start();
    const human = new PlanchatClient({ url, token: TOKEN });
    const t = await human.createThread({ ws: "w", file: "plan.md", anchor: { exact: "ship it" }, body: "when?" });
    writeFileSync(join(root, "plan.md"), "# Plan\n\nNew intro line.\n\nStep one: build it.\nStep two: ship it.\n");
    await until(() => server.hub.ws("w").thread(t.id).anchor.fileHash !== t.anchor.fileHash, 4000);
    const after = await human.getThread(t.id);
    expect(after.anchor.state).toBe("moved");
    expect(after.lines).toEqual({ from: 6, to: 6 });
    writeFileSync(join(root, "plan.md"), "# Plan\n\nNew intro line.\n\nStep one: build it.\n");
    await until(() => server.hub.ws("w").thread(t.id).anchor.state === "orphaned", 4000);
  });
});
