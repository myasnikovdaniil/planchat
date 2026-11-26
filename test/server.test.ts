import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type Config } from "../src/config.ts";
import { PlanchatClient, streamEvents } from "../src/client.ts";
import { isLoopback, PlanchatServer } from "../src/server.ts";
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

describe("session scope, workspace roots, listen info", () => {
  test("/api/files?session= lists only the files that session is subscribed to", async () => {
    writeFileSync(join(root, "notes.md"), "notes\n");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "a.md"), "a\n");
    const url = await start();
    const auth = { authorization: `Bearer ${TOKEN}` };
    const human = new PlanchatClient({ url, token: TOKEN });
    await human.createThread({ ws: "w", file: "notes.md", anchor: { exact: "notes" }, body: "x" });
    await new PlanchatClient({ url, token: TOKEN, session: "rev" }).subscribe({ ws: "w", globs: ["plan.md", "docs/**"] });

    const all = await (await fetch(`${url}/api/files?ws=w`, { headers: auth })).json();
    expect(all.files).toEqual(["docs/a.md", "notes.md", "plan.md"]);
    expect(all.scope).toBeUndefined();

    const scoped = await (await fetch(`${url}/api/files?ws=w&session=rev`, { headers: auth })).json();
    expect(scoped.files).toEqual(["docs/a.md", "plan.md"]);
    expect(scoped.scope).toEqual({ session: "rev", globs: ["plan.md", "docs/**"] });
    expect(scoped.threads).toEqual({}); // the thread on notes.md is outside the scope

    const nobody = await (await fetch(`${url}/api/files?ws=w&session=ghost`, { headers: auth })).json();
    expect(nobody.files).toEqual([]);
    expect(nobody.scope).toEqual({ session: "ghost", globs: [] });
  });

  test("a second workspace on a root already in use is refused, also through a symlink", async () => {
    const url = await start();
    const human = new PlanchatClient({ url, token: TOKEN });
    await expect(human.addWorkspace("w2", root)).rejects.toMatchObject({ status: 409, code: "root_taken" });
    const link = join(home, "link-to-root");
    symlinkSync(root, link);
    await expect(human.addWorkspace("w3", link)).rejects.toMatchObject({ status: 409, code: "root_taken" });
    const other = mkdtempSync(join(tmpdir(), "planchat-other-"));
    expect((await human.addWorkspace("w4", other)).name).toBe("w4");
  });

  test("a duplicate root in the config is skipped at startup, the daemon still starts", async () => {
    const url = await start(true, {
      workspaces: [
        { name: "w", root, include: ["**"], exclude: [] },
        { name: "again", root, include: ["**"], exclude: [] },
      ],
    });
    const list = await new PlanchatClient({ url, token: TOKEN }).workspaces();
    expect(list.map((w) => w.name)).toEqual(["w"]);
  });

  test("/api/me reports the listen port, LAN address and auth mode", async () => {
    const url = await start();
    const me = await new PlanchatClient({ url, token: TOKEN }).me();
    expect(me.listen).toEqual({ port: server.port, lan: null, auth: true });
  });

  const lanAddr = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  test.skipIf(!lanAddr)("a workspace is added over loopback only, not over the LAN address, even without auth", async () => {
    // one fixed port: with 0 the loopback and LAN listeners would each get their own
    const port = 20000 + Math.floor(Math.random() * 20000);
    const cfg: Config = { ...defaultConfig(), port, workspaces: [{ name: "w", root, include: ["**"], exclude: [] }], debounceMs: 30 };
    server = new PlanchatServer(cfg, { port, lan: lanAddr!, auth: false, persist: false, quiet: true, configFile: join(home, "config.json") });
    await server.start();
    const other = mkdtempSync(join(tmpdir(), "planchat-other-"));
    const add = (host: string, name: string) =>
      fetch(`http://${host}:${server.port}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, root: other }) });
    const viaLan = await add(lanAddr!, "grab");
    expect(viaLan.status).toBe(403);
    expect((await viaLan.json()).message).toContain("from this machine only");
    expect((await add("127.0.0.1", "local")).status).toBe(201);
  });

  test("isLoopback accepts 127.0.0.0/8 and ::1 only", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(a)).toBe(true);
    for (const a of ["192.168.0.228", "10.0.0.1", "::ffff:192.168.0.1", "fe80::1", "", undefined]) expect(isLoopback(a)).toBe(false);
  });
});
