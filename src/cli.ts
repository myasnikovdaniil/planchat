#!/usr/bin/env bun
// planchat: serve | events | mcp | thread operations | ws add | token add

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { planchatHome, configPath, loadConfig, saveConfig, SESSION_NAME_RE, tokenPath, normalizeWorkspace, readToken } from "./config.ts";
import { PlanchatClient, ClientError, streamEvents, type AnchorArg } from "./client.ts";
import { fmtThread, fmtThreadFull } from "./format.ts";
import { sha256 } from "./store.ts";
import { agentFromEnv, defaultSessionName } from "./agent.ts";

const VERSION = "0.1.0";

const HELP = `planchat ${VERSION} — comments on character ranges of files, delivered to running coding agents (Claude Code, Codex, any shell or MCP client)

daemon
  planchat serve [--port N] [--lan ADDR] [--no-auth [--no-auth-lan]]
  planchat ws add NAME PATH [--include GLOB]... [--exclude GLOB]...
  planchat ws list
  planchat token add NAME [--save]        print a new token once (--save: also write ~/.config/planchat/token)

session side
  planchat events [--session NAME] [--cwd DIR]   one line per event addressed to the session (run under Monitor)
  planchat mcp [--session NAME] [--channel]      MCP shim (stdio); --channel pushes events as channel notifications
  planchat attach codex [--session NAME] [--thread ID]   the daemon queues events into this Codex thread (codex queue)
  planchat detach [--session NAME]               stop delivering into Codex
  planchat subscribe [WS] [GLOB]...              change what the session hears (default: workspace of cwd, **)
  planchat unsubscribe [WS]
  planchat sessions
  planchat url [FILE] [--ws W] [--mode source|rendered] [--no-token]
                                                 links to the UI: local, plus lan when the daemon listens on one;
                                                 with --session the page lists only that session's files

threads (sessions pass --session NAME)
  planchat list [--ws W] [--file F] [--status open|resolved|all] [--since SEQ|ISO]
  planchat get THREAD
  planchat reply THREAD BODY|-
  planchat create FILE BODY|- (--exact TEXT [--nth N] | --start N --end N [--base-hash H]) [--ws W]
  planchat react TARGET KIND [--off]             TARGET is a thread id (root comment) or a comment id
  planchat claim THREAD | release THREAD | resolve THREAD | reopen THREAD

global flags
  --session NAME   act as this session (alias --session-name, or env PLANCHAT_SESSION)
  --human          act as the token's human even inside a Claude Code shell
  --url URL        daemon URL (env PLANCHAT_URL, default http://127.0.0.1:7717)
  --json           machine-readable output
`;

function die(msg: string, code = 1): never {
  process.stderr.write(`planchat: ${msg}\n`);
  process.exit(code);
}

async function readBody(arg: string | undefined): Promise<string> {
  if (arg === undefined) die("body is required (use - to read stdin)");
  if (arg !== "-") return arg;
  return await new Response(Bun.stdin.stream()).text();
}


async function main(argv: string[]) {
  const { values: v, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      session: { type: "string" },
      "session-name": { type: "string" },
      human: { type: "boolean" },
      url: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      // serve
      port: { type: "string" },
      lan: { type: "string" },
      "no-auth": { type: "boolean" },
      "no-auth-lan": { type: "boolean" },
      // ws add
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      // token
      save: { type: "boolean" },
      // events, mcp, attach
      cwd: { type: "string" },
      thread: { type: "string" },
      channel: { type: "boolean" },
      // list
      ws: { type: "string" },
      file: { type: "string" },
      status: { type: "string" },
      since: { type: "string" },
      // create
      exact: { type: "string" },
      nth: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      "base-hash": { type: "string" },
      // react
      off: { type: "boolean" },
      // url
      mode: { type: "string" },
      "no-token": { type: "boolean" },
    },
  });
  if (v.version) return console.log(VERSION);
  const cmd = pos[0];
  if (!cmd || v.help || cmd === "help") return process.stdout.write(HELP);

  const session = v.session ?? v["session-name"] ?? process.env.PLANCHAT_SESSION;
  if (session && !SESSION_NAME_RE.test(session)) die(`bad session name ${session}: ${SESSION_NAME_RE}`);
  const client = () =>
    new PlanchatClient({
      url: v.url,
      session,
      agent: v.human ? undefined : agentFromEnv(),
      asHuman: v.human,
    });
  const print = (data: unknown, text: () => string) => console.log(v.json ? JSON.stringify(data, null, 2) : text());

  switch (cmd) {
    case "serve": {
      const { PlanchatServer } = await import("./server.ts");
      if (!existsSync(configPath())) {
        saveConfig(loadConfig());
        console.error(`[planchat] wrote default config ${configPath()}`);
      }
      const cfg = loadConfig();
      const auth = !v["no-auth"];
      let lan = v.lan ?? cfg.lan;
      if (!auth && lan && !v["no-auth-lan"]) {
        console.error(`[planchat] --no-auth listens on 127.0.0.1 only; not binding ${lan} (add --no-auth-lan to force it)`);
        lan = null;
      }
      const server = new PlanchatServer(cfg, { port: v.port ? Number(v.port) : cfg.port, lan, auth });
      try {
        await server.start();
      } catch (e) {
        die(e instanceof Error ? e.message : String(e));
      }
      if (server.hub.workspaces.size === 0) console.error("[planchat] no workspaces yet: planchat ws add <name> <path>");
      const stop = () => {
        server.stop();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }

    case "ws": {
      const sub = pos[1];
      if (sub === "list") {
        let list: { name: string; root: string }[];
        try {
          list = await client().workspaces();
        } catch {
          list = loadConfig().workspaces;
        }
        return print(list, () => list.map((w) => `${w.name}\t${w.root}`).join("\n") || "(no workspaces)");
      }
      if (sub !== "add") die("usage: planchat ws add NAME PATH | planchat ws list");
      const [name, path] = [pos[2], pos[3]];
      if (!name || !path) die("usage: planchat ws add NAME PATH");
      const root = resolve(path);
      if (!existsSync(root)) die(`${root} does not exist`);
      try {
        await client().addWorkspace(name, root, v.include ?? [], v.exclude ?? []);
        return console.log(`added workspace ${name} → ${root} (daemon and config)`);
      } catch (e) {
        if (!(e instanceof ClientError) || e.status !== 0) die(e instanceof Error ? e.message : String(e));
      }
      const cfg = loadConfig();
      if (cfg.workspaces.some((w) => w.name === name)) die(`workspace ${name} already exists in ${configPath()}`);
      cfg.workspaces.push(normalizeWorkspace({ name, root, include: v.include, exclude: v.exclude }));
      saveConfig(cfg);
      return console.log(`added workspace ${name} → ${root} in ${configPath()} (daemon not running)`);
    }

    case "token": {
      if (pos[1] !== "add" || !pos[2]) die("usage: planchat token add NAME [--save]");
      const name = pos[2];
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) die(`bad token name ${name}`);
      const token = randomBytes(32).toString("base64url");
      const cfg = loadConfig();
      cfg.tokens[name] = sha256(token);
      saveConfig(cfg);
      if (v.save) {
        mkdirSync(planchatHome(), { recursive: true, mode: 0o700 });
        writeFileSync(tokenPath(), token + "\n", { mode: 0o600 });
        chmodSync(tokenPath(), 0o600);
      }
      console.log(token);
      console.error(`token for ${name} stored as a hash in ${configPath()}${v.save ? `; written to ${tokenPath()}` : ""}`);
      console.error(`UI: http://127.0.0.1:${cfg.port}/?token=${token}`);
      return;
    }

    case "events": {
      let name = session;
      if (!name) {
        const d = defaultSessionName();
        name = d.name;
        console.error(
          `[planchat] no --session/PLANCHAT_SESSION: using ${name}. ${d.stable ? "It is stable for this agent session only;" : "It is random;"} claims will not survive a session restart.`,
        );
      }
      const cwd = resolve(v.cwd ?? process.cwd());
      const c = new PlanchatClient({ url: v.url, session: name });
      let first = true;
      const write = (line: string) => new Promise<void>((ok) => process.stdout.write(line + "\n", () => ok()));
      streamEvents(
        c,
        { session: name, cwd, transport: "events", agent: agentFromEnv() },
        {
          hello: (h) => {
            const subs = h.subscriptions.map((s) => `${s.ws}:${s.globs.join(",")}`).join(" ") || "none";
            const text = `[planchat] connected as ${h.session}; subscribed: ${subs}; pending: ${h.pending}${h.notes.length ? `; ${h.notes.join("; ")}` : ""}`;
            if (first) void write(text);
            else process.stderr.write(text + "\n");
            first = false;
          },
          event: (e) => write(e.line),
          fatal: (m) => {
            void write(`[planchat] error: ${m}`).then(() => process.exit(2));
          },
          status: (s) => process.stderr.write(`[planchat] ${s}\n`),
        },
      );
      return;
    }

    case "mcp": {
      const { runMcp } = await import("./mcp.ts");
      return runMcp({ url: v.url, session, channel: v.channel });
    }

    case "attach": {
      if (pos[1] !== "codex") die("usage: planchat attach codex [--session NAME] [--thread ID] (Claude Code sessions use planchat events or planchat mcp)");
      const thread = v.thread ?? process.env.CODEX_THREAD_ID;
      if (!thread) die("no Codex thread: run this inside Codex (CODEX_THREAD_ID is set there) or pass --thread");
      const name = session ?? defaultSessionName(`codex:${thread}`).name;
      const c = new PlanchatClient({ url: v.url, session: name });
      const r = await c.attach({ kind: "codex", session: name, thread, cwd: resolve(v.cwd ?? process.cwd()) });
      const subs = r.subscriptions.map((s) => `${s.ws}:${s.globs.join(",")}`).join(" ") || "none (run planchat subscribe <ws>)";
      return print(r, () => `attached session ${r.session} to codex thread ${r.thread}; subscribed: ${subs}; pending: ${r.pending}\nevents arrive in this Codex session as new messages; act with: planchat --session ${r.session} <command>`);
    }

    case "detach": {
      const r = await client().detach(session);
      return print(r, () => (r.detached ? `detached ${r.session}` : `${r.session} was not attached`));
    }

    case "sessions": {
      const list = await client().sessions();
      return print(list, () =>
        list
          .map((s) => `${s.online ? "●" : "○"} ${s.name}${s.transport ? ` (${s.transport})` : ""}  ${s.subscriptions.map((x: any) => `${x.ws}:${x.globs.join(",")}@${x.cursor}`).join(" ")}`)
          .join("\n") || "(no sessions)",
      );
    }

    case "subscribe":
    case "unsubscribe": {
      if (!session && !agentFromEnv()) die(`${cmd} needs --session NAME`);
      const ws = pos[1];
      const globs = pos.slice(2);
      const c = client();
      const r = cmd === "subscribe" ? await c.subscribe({ ws, cwd: process.cwd(), globs }) : await c.unsubscribe({ ws, cwd: process.cwd() });
      return print(r, () => `${(r as any).name}: ${((r as any).subscriptions ?? []).map((x: any) => `${x.ws}:${x.globs.join(",")}`).join(" ") || "no subscriptions"}`);
    }

    case "url": {
      const c = client();
      const me = await c.me();
      // address, port and auth as the running daemon sees them, not as the config file says
      const listen: { port: number; lan: string | null; auth: boolean } = me.listen ?? { port: Number(new URL(c.url).port || 7717), lan: null, auth: true };
      const spaces: { name: string; root: string }[] = me.workspaces;
      const fileArg = pos[1];
      const abs = resolve(fileArg ?? process.cwd());
      const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
      const w = v.ws ? spaces.find((x) => x.name === v.ws) : spaces.filter((x) => inside(x.root, abs)).sort((a, b) => b.root.length - a.root.length)[0];
      if (v.ws && !w) die(`no workspace ${v.ws}; see planchat ws list`);
      if (!w) die(fileArg ? `${abs} is in no workspace; see planchat ws list` : "the current directory is in no workspace: pass --ws W or a FILE");
      let rel: string | undefined;
      if (fileArg) {
        if (abs === w.root || !inside(w.root, abs)) die(`${abs} is not a file inside workspace ${w.name} (${w.root})`);
        rel = relative(w.root, abs).split(sep).join("/");
        const listed = await c.request<{ files: string[] }>("GET", `/api/files?${new URLSearchParams({ ws: w.name })}`);
        if (!listed.files.includes(rel)) die(`${rel} is not shown in workspace ${w.name}: it is missing, gitignored, excluded or binary`);
      }
      if (v.mode !== undefined && v.mode !== "source" && v.mode !== "rendered") die("--mode is source or rendered");
      // --session, or the session this agent shell is connected as (planchat events / attach codex)
      const scoped: string | undefined = session ?? (me.author?.kind === "session" ? me.author.name : undefined);
      if (scoped) {
        const sub = (await c.sessions()).find((s) => s.name === scoped)?.subscriptions?.find((x: any) => x.ws === w.name);
        if (!sub) process.stderr.write(`planchat: session ${scoped} is not subscribed to ${w.name}, so the page lists no files; run planchat --session ${scoped} subscribe ${w.name} ${rel ?? "GLOB"}\n`);
      }
      let token = "";
      if (listen.auth && !v["no-token"]) {
        const t = readToken();
        if (!t) die("the daemon wants a token and none is saved here: run planchat token add <name> --save");
        token = t;
      }
      const hash = new URLSearchParams({ ws: w.name });
      if (rel) hash.set("file", rel);
      if (v.mode) hash.set("mode", v.mode);
      if (scoped) hash.set("session", scoped);
      const page = (host: string) => `http://${host.includes(":") ? `[${host}]` : host}:${listen.port}/${token ? `?token=${encodeURIComponent(token)}` : ""}#${hash}`;
      const out = {
        local: page("127.0.0.1"),
        lan: listen.lan && listen.lan !== "127.0.0.1" ? page(listen.lan) : null,
        ws: w.name,
        file: rel ?? null,
        session: scoped ?? null,
      };
      return print(out, () => [`local\t${out.local}`, ...(out.lan ? [`lan\t${out.lan}`] : [])].join("\n"));
    }

    case "list": {
      const list = await client().listThreads({ ws: v.ws, file: v.file, status: v.status, since: v.since });
      return print(list, () => list.map(fmtThread).join("\n") || "(no threads)");
    }

    case "get": {
      if (!pos[1]) die("usage: planchat get THREAD");
      const t = await client().getThread(pos[1]);
      return print(t, () => fmtThreadFull(t));
    }

    case "reply": {
      if (!pos[1]) die("usage: planchat reply THREAD BODY|-");
      const body = await readBody(pos[2]);
      const t = await client().reply(pos[1], body);
      return print(t, () => `replied on ${t.id}`);
    }

    case "create": {
      const file = pos[1];
      if (!file) die("usage: planchat create FILE BODY|- (--exact TEXT [--nth N] | --start N --end N)");
      const body = await readBody(pos[2]);
      let anchor: AnchorArg;
      if (v.exact !== undefined) anchor = { exact: v.exact, ...(v.nth !== undefined ? { nth: Number(v.nth) } : {}) };
      else if (v.start !== undefined && v.end !== undefined) {
        anchor = { start: Number(v.start), end: Number(v.end), ...(v["base-hash"] ? { baseHash: v["base-hash"] } : {}) };
      } else die("create needs --exact TEXT or --start N --end N");
      const t = await client().createThread({ ws: v.ws, cwd: process.cwd(), file: resolve(file), anchor, body });
      return print(t, () => `created ${t.id} on ${t.file}`);
    }

    case "react": {
      const [target, kind] = [pos[1], pos[2]];
      if (!target || !kind) die("usage: planchat react TARGET KIND [--off]");
      const t = await client().react(target, kind, !v.off);
      return print(t, () => `${v.off ? "removed" : "set"} ${kind} on ${target}`);
    }

    case "claim": {
      if (!pos[1]) die("usage: planchat claim THREAD");
      const r = await client().claim(pos[1]);
      if (!r.ok) {
        print(r, () => `not claimed: claimed_by ${r.claimed_by}`);
        process.exit(3);
      }
      return print(r, () => `claimed ${pos[1]}`);
    }

    case "release":
    case "resolve":
    case "reopen": {
      if (!pos[1]) die(`usage: planchat ${cmd} THREAD`);
      const t = await client()[cmd](pos[1]);
      const done = { release: "released", resolve: "resolved", reopen: "reopened" }[cmd];
      return print(t, () => `${done} ${t.id}`);
    }

    default:
      die(`unknown command ${cmd}; see planchat --help`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof ClientError) die(`${e.message}${e.code && e.code !== "error" ? ` [${e.code}]` : ""}`, e.status === 409 ? 3 : 1);
  die(e instanceof Error ? e.message : String(e));
});
