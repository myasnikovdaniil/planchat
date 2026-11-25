// All workspaces of the daemon, session presence, live connections of
// `planchat events` / `planchat mcp`, and the fan-out to UI streams.

import { sep } from "node:path";
import { CODEX_THREAD_RE, CodexConnection, spawnCodexQueue, type CodexQueue } from "./codex.ts";
import { readJson, writeFileAtomic } from "./store.ts";
import { lineRange } from "./anchor.ts";
import { SESSION_NAME_RE, WORKSPACE_NAME_RE, normalizeWorkspace, type Config, type WorkspaceConfig } from "./config.ts";
import { formatEvent } from "./format.ts";
import { diffStats, lineDiff, type LineDiff } from "./linediff.ts";
import { claimIsStale } from "./router.ts";
import type { Change, Thread } from "./state.ts";
import type { StoredEvent } from "./store.ts";
import { OpError, Workspace, type WorkspaceHooks } from "./workspace.ts";

export type Transport = "events" | "mcp" | "codex";

export interface Connection {
  session: string;
  transport: Transport;
  /** "claude:<id>" / "codex:<id>": the agent session behind this connection */
  agent?: string;
  send(msg: unknown): void;
  close(code: number, reason: string): void;
}

export interface Presence {
  online: boolean;
  lastSeen: number;
  transport?: Transport;
  agent?: string;
}

export type StreamMsg =
  | { type: "event"; ws: string; event: StoredEvent }
  | { type: "file"; ws: string; path: string; hash: string | null }
  | { type: "tree"; ws: string }
  | { type: "sessions" };

export interface ThreadView extends Thread {
  ws: string;
  lines: { from: number; to: number } | null;
  claimStale: boolean;
}

export interface EventMsg {
  type: "event";
  ws: string;
  seq: number;
  id: string;
  thread: string;
  line: string;
  meta: Record<string, string>;
}

export class Hub implements WorkspaceHooks {
  readonly workspaces = new Map<string, Workspace>();
  readonly presence = new Map<string, Presence>();
  private readonly conns = new Map<string, Connection>();
  private readonly listeners = new Set<(m: StreamMsg) => void>();
  private readonly startedAt: number;

  constructor(
    public cfg: Config,
    private readonly opts: {
      watch?: boolean;
      now?: () => number;
      /** where Codex attachments persist; none: they live until the daemon stops */
      attachmentsPath?: string;
      codexQueue?: CodexQueue;
    } = {},
  ) {
    this.startedAt = this.now();
  }

  now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  start(): void {
    for (const w of this.cfg.workspaces) this.addWorkspace(w);
    for (const [session, a] of Object.entries(this.loadAttachments())) {
      try {
        this.attachCodex(session, a.thread, a.cwd, false);
      } catch (e) {
        console.error(`[planchat] could not restore codex attachment ${session}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // --------------------------------------------------------------- codex

  private loadAttachments(): Record<string, { kind: "codex"; thread: string; cwd?: string }> {
    return this.opts.attachmentsPath ? readJson(this.opts.attachmentsPath, {}) : {};
  }

  private saveAttachments(all: Record<string, { kind: "codex"; thread: string; cwd?: string }>): void {
    if (this.opts.attachmentsPath) writeFileAtomic(this.opts.attachmentsPath, JSON.stringify(all, null, 1));
  }

  /**
   * Deliver a session's events into a Codex thread. The daemon itself runs
   * `codex queue`: a Codex sandbox cannot write to ~/.codex, so the agent
   * only registers its thread once. Survives daemon restarts.
   */
  attachCodex(session: string, thread: string, cwd?: string, persist = true): { subscriptions: { ws: string; globs: string[] }[]; pending: number } {
    if (!SESSION_NAME_RE.test(session)) throw new OpError(400, "bad_request", `bad session name ${session}`);
    if (!CODEX_THREAD_RE.test(thread)) throw new OpError(400, "bad_request", `bad codex thread id ${thread}`);
    const queue = this.opts.codexQueue ?? spawnCodexQueue(this.cfg.codexBin);
    const c = new CodexConnection(session, thread, cwd, queue, (ws, seq) => this.ack(session, ws, seq), (m) => console.error(m));
    let hello: { subscriptions: { ws: string; globs: string[] }[]; pending: number } = { subscriptions: [], pending: 0 };
    const send = c.send.bind(c);
    c.send = (msg: any) => {
      if (msg?.type === "hello") hello = { subscriptions: msg.subscriptions, pending: msg.pending };
      send(msg);
    };
    const r = this.connect(c, cwd);
    if (!r.ok) throw new OpError(409, "conflict", r.error);
    if (persist) {
      const all = this.loadAttachments();
      all[session] = { kind: "codex", thread, ...(cwd ? { cwd } : {}) };
      this.saveAttachments(all);
    }
    return hello;
  }

  /** Stop delivering into Codex for a session. */
  detach(session: string): boolean {
    const all = this.loadAttachments();
    const had = session in all;
    delete all[session];
    this.saveAttachments(all);
    const c = this.conns.get(session);
    if (c && c.transport === "codex") {
      c.close(1000, "detached");
      this.disconnect(c);
      return true;
    }
    return had;
  }

  stop(): void {
    for (const c of this.conns.values()) c.close(1001, "daemon stopping");
    for (const w of this.workspaces.values()) w.close();
  }

  addWorkspace(input: WorkspaceConfig): Workspace {
    const wc = normalizeWorkspace(input);
    if (!WORKSPACE_NAME_RE.test(wc.name)) throw new OpError(400, "bad_request", `bad workspace name ${wc.name}`);
    if (this.workspaces.has(wc.name)) throw new OpError(409, "exists", `workspace ${wc.name} already exists`);
    const ws = new Workspace(
      wc,
      {
        snapshots: this.cfg.snapshots,
        quoteThreshold: this.cfg.quoteThreshold,
        debounceMs: this.cfg.debounceMs,
        reactions: this.cfg.reactions,
      },
      this,
    );
    const report = ws.open();
    if (report.tornPath) console.error(`[planchat] ${wc.name}: damaged log tail (${report.tornBytes} bytes) moved to ${report.tornPath}`);
    if (this.opts.watch !== false) ws.startWatching();
    this.workspaces.set(wc.name, ws);
    for (const s of ws.delivery.list()) {
      if (!this.presence.has(s.session)) this.presence.set(s.session, { online: false, lastSeen: this.startedAt });
    }
    return ws;
  }

  ws(name: string | undefined | null): Workspace {
    if (!name) {
      if (this.workspaces.size === 1) return [...this.workspaces.values()][0];
      throw new OpError(400, "bad_request", "ws is required when the daemon has several workspaces");
    }
    const w = this.workspaces.get(name);
    if (!w) throw new OpError(404, "not_found", `workspace ${name} not found`);
    return w;
  }

  /** Workspace owning a thread or comment id. */
  wsOf(id: string): Workspace {
    for (const w of this.workspaces.values()) if (w.state.threadOf(id)) return w;
    throw new OpError(404, "not_found", `thread or comment ${id} not found`);
  }

  /** The workspace with the longest root that contains `dir`. */
  wsForDir(dir: string): Workspace | undefined {
    let best: Workspace | undefined;
    for (const w of this.workspaces.values()) {
      const inside = dir === w.root || dir.startsWith(w.root.endsWith(sep) ? w.root : w.root + sep);
      if (inside && (!best || w.root.length > best.root.length)) best = w;
    }
    return best;
  }

  /** Session name an agent session ("claude:<id>", "codex:<id>") registered through events, mcp or attach. */
  sessionForAgent(agent: string): string | undefined {
    for (const c of this.conns.values()) if (c.agent === agent) return c.session;
    for (const [name, p] of this.presence) if (p.agent === agent) return name;
    return undefined;
  }

  // ---------------------------------------------------------------- views

  threadView(ws: Workspace, t: Thread, text?: string | null): ThreadView {
    const content = text === undefined ? ws.tryRead(t.file) : text;
    const lines = content !== null && t.anchor.state !== "orphaned" ? lineRange(content, t.anchor.start, t.anchor.end) : null;
    const graceMs = this.cfg.graceSeconds * 1000;
    const withStats = (c: Change | undefined): Change | undefined => (c ? { ...c, stats: this.changeStats(ws, c) } : undefined);
    return {
      ...t,
      comments: t.comments.map((c) => (c.change ? { ...c, change: withStats(c.change) } : c)),
      resolved: t.resolved ? { ...t.resolved, change: withStats(t.resolved.change) } : undefined,
      ws: ws.name,
      lines,
      claimStale: claimIsStale(t, (s) => this.presence.get(s), this.now(), graceMs),
    };
  }

  private statsCache = new Map<string, { added: number; removed: number } | null>();

  /** Lines added/removed between two snapshots; null when either version is gone. Cached: versions never change. */
  changeStats(ws: Workspace, c: { from: string; to: string }): { added: number; removed: number } | null {
    const key = `${c.from}:${c.to}`;
    if (this.statsCache.has(key)) return this.statsCache.get(key)!;
    const a = ws.snapshots.get(c.from);
    const b = ws.snapshots.get(c.to);
    const v = a === null || b === null ? null : diffStats(a, b);
    if (this.statsCache.size > 5000) this.statsCache.clear();
    this.statsCache.set(key, v);
    return v;
  }

  /** Full line diff between two snapshots of a workspace file. */
  diff(ws: Workspace, from: string, to: string): LineDiff {
    const hex = /^[0-9a-f]{64}$/;
    if (!hex.test(from) || !hex.test(to)) throw new OpError(400, "bad_request", "from and to are snapshot hashes");
    const a = ws.snapshots.get(from);
    const b = ws.snapshots.get(to);
    if (a === null || b === null) throw new OpError(404, "gone", "that version of the file is no longer kept");
    return lineDiff(a, b);
  }

  threadViews(ws: Workspace, threads: Thread[]): ThreadView[] {
    const texts = new Map<string, string | null>();
    return threads.map((t) => {
      if (!texts.has(t.file)) texts.set(t.file, ws.tryRead(t.file));
      return this.threadView(ws, t, texts.get(t.file));
    });
  }

  sessions(): { name: string; online: boolean; lastSeen: number; transport?: Transport; subscriptions: { ws: string; globs: string[]; cursor: number }[] }[] {
    const names = new Set<string>(this.presence.keys());
    for (const w of this.workspaces.values()) for (const s of w.delivery.list()) names.add(s.session);
    return [...names].sort().map((name) => {
      const p = this.presence.get(name) ?? { online: false, lastSeen: this.startedAt };
      const subscriptions = [...this.workspaces.values()].flatMap((w) => {
        const s = w.delivery.subs.get(name);
        return s ? [{ ws: w.name, globs: s.globs, cursor: s.cursor }] : [];
      });
      return { name, online: p.online, lastSeen: p.lastSeen, transport: p.transport, subscriptions };
    });
  }

  // ------------------------------------------------------------- streams

  listen(fn: (m: StreamMsg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private broadcast(m: StreamMsg): void {
    for (const fn of this.listeners) {
      try {
        fn(m);
      } catch {
        /* a broken stream unsubscribes itself */
      }
    }
  }

  appended(ws: Workspace, ev: StoredEvent, names: string[]): void {
    this.broadcast({ type: "event", ws: ws.name, event: ev });
    for (const n of names) {
      const c = this.conns.get(n);
      if (c && ws.deliverable(n, ev)) this.sendEvent(c, ws, ev);
    }
  }

  fileChanged(ws: Workspace, path: string, hash: string | null): void {
    this.broadcast({ type: "file", ws: ws.name, path, hash });
  }

  treeChanged(ws: Workspace): void {
    this.broadcast({ type: "tree", ws: ws.name });
  }

  formatFor(ws: Workspace, ev: StoredEvent): EventMsg | null {
    const t = ws.state.thread(String(ev.thread));
    if (!t) return null;
    const { line, meta } = formatEvent(ws.name, ev, t, ws.tryRead(t.file));
    return { type: "event", ws: ws.name, seq: ev.seq, id: ev.id, thread: t.id, line, meta };
  }

  private sendEvent(c: Connection, ws: Workspace, ev: StoredEvent): void {
    const msg = this.formatFor(ws, ev);
    if (msg) c.send(msg);
  }

  // --------------------------------------------------------- connections

  /**
   * Register a live connection. A second connection under an online name is
   * refused, unless it comes from the same Claude Code session (a re-armed
   * Monitor whose old process has not been reaped yet).
   */
  connect(c: Connection, cwd?: string): { ok: true } | { ok: false; error: string } {
    if (!SESSION_NAME_RE.test(c.session)) return { ok: false, error: `bad session name ${c.session}` };
    const existing = this.conns.get(c.session);
    if (existing) {
      if (c.agent && existing.agent === c.agent) {
        existing.close(4000, "replaced by a new connection of the same session");
      } else {
        return { ok: false, error: `session name ${c.session} is already connected` };
      }
    }
    this.conns.set(c.session, c);
    this.presence.set(c.session, { online: true, lastSeen: this.now(), transport: c.transport, agent: c.agent });

    const notes: string[] = [];
    let subscribed = [...this.workspaces.values()].filter((w) => w.delivery.subs.has(c.session));
    if (subscribed.length === 0) {
      const w = cwd ? this.wsForDir(cwd) : undefined;
      if (w) {
        w.subscribe(c.session, ["**"]);
        subscribed = [w];
      } else {
        notes.push(cwd ? `no workspace contains ${cwd}; run planchat subscribe <ws>` : "not subscribed to any workspace; run planchat subscribe <ws>");
      }
    }
    c.send({
      type: "hello",
      session: c.session,
      subscriptions: subscribed.map((w) => ({ ws: w.name, globs: w.delivery.subs.get(c.session)!.globs })),
      pending: subscribed.reduce((n, w) => n + w.backlog(c.session).length, 0),
      notes,
    });
    this.flush(c);
    this.broadcast({ type: "sessions" });
    return { ok: true };
  }

  /** Send everything addressed to the session after its cursor. */
  flush(c: Connection): void {
    for (const w of this.workspaces.values()) {
      if (!w.delivery.subs.has(c.session)) continue;
      for (const ev of w.backlog(c.session)) this.sendEvent(c, w, ev);
    }
  }

  disconnect(c: Connection): void {
    if (this.conns.get(c.session) !== c) return;
    this.conns.delete(c.session);
    const p = this.presence.get(c.session);
    this.presence.set(c.session, { ...p, online: false, lastSeen: this.now() });
    this.broadcast({ type: "sessions" });
  }

  touch(session: string): void {
    const p = this.presence.get(session);
    if (p) p.lastSeen = this.now();
  }

  ack(session: string, wsName: string, seq: number): void {
    const w = this.workspaces.get(wsName);
    if (!w) return;
    w.delivery.ack(session, seq);
    this.touch(session);
  }

  isOnline(session: string): boolean {
    return this.conns.has(session);
  }

  subscribe(session: string, wsName: string, globs: string[]): void {
    if (!SESSION_NAME_RE.test(session)) throw new OpError(400, "bad_request", `bad session name ${session}`);
    const w = this.ws(wsName);
    w.subscribe(session, globs);
    if (!this.presence.has(session)) this.presence.set(session, { online: false, lastSeen: this.now() });
    const c = this.conns.get(session);
    if (c) this.flush(c);
    this.broadcast({ type: "sessions" });
  }

  unsubscribe(session: string, wsName: string): void {
    this.ws(wsName).delivery.unsubscribe(session);
    this.broadcast({ type: "sessions" });
  }
}
