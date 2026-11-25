// Daemon client shared by the CLI and the MCP shim.

import { readToken } from "./config.ts";
import type { EventMsg, ThreadView } from "./hub.ts";

export class ClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ClientOptions {
  url?: string;
  token?: string | null;
  /** act as this session */
  session?: string;
  /** the calling agent session ("claude:<id>" / "codex:<id>"), if any */
  agent?: string;
  /** force human identity inside a Claude Code shell */
  asHuman?: boolean;
}

export function defaultUrl(): string {
  return process.env.PLANCHAT_URL ?? `http://127.0.0.1:${process.env.PLANCHAT_PORT ?? 7717}`;
}

export type AnchorArg = { start: number; end: number; baseHash?: string } | { exact: string; nth?: number };

export class PlanchatClient {
  readonly url: string;
  private readonly token: string | null;

  constructor(readonly opts: ClientOptions = {}) {
    this.url = (opts.url ?? defaultUrl()).replace(/\/$/, "");
    this.token = opts.token === undefined ? readToken() : opts.token;
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (this.opts.session) h["x-planchat-session"] = this.opts.session;
    else if (this.opts.agent) h["x-planchat-agent"] = this.opts.agent;
    if (this.opts.asHuman) h["x-planchat-as-human"] = "1";
    return h;
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url + path, {
        method,
        headers: { ...this.headers(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ClientError(0, "unreachable", `planchat daemon is not reachable at ${this.url} (${e instanceof Error ? e.message : e}); start it with \`planchat serve\``);
    }
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }
    if (!res.ok && !(res.status === 409 && data?.claimed_by)) {
      throw new ClientError(res.status, data?.error ?? "error", data?.message ?? `HTTP ${res.status}`, data);
    }
    return data as T;
  }

  me() {
    return this.request("GET", "/api/me");
  }
  workspaces() {
    return this.request<{ name: string; root: string }[]>("GET", "/api/workspaces");
  }
  addWorkspace(name: string, root: string, include: string[] = [], exclude: string[] = []) {
    return this.request("POST", "/api/workspaces", { name, root, include, exclude });
  }
  sessions() {
    return this.request<any[]>("GET", "/api/sessions");
  }
  listThreads(f: { ws?: string; file?: string; status?: string; since?: string } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
    return this.request<ThreadView[]>("GET", `/api/threads?${q}`);
  }
  getThread(id: string) {
    return this.request<ThreadView>("GET", `/api/threads/${encodeURIComponent(id)}`);
  }
  file(ws: string | undefined, path: string) {
    const q = new URLSearchParams({ path });
    if (ws) q.set("ws", ws);
    return this.request<{ ws: string; path: string; content: string; hash: string }>("GET", `/api/file?${q}`);
  }
  createThread(a: { ws?: string; cwd?: string; file: string; anchor: AnchorArg; body: string }) {
    return this.request<ThreadView>("POST", "/api/threads", a);
  }
  reply(thread: string, body: string) {
    return this.request<ThreadView>("POST", `/api/threads/${encodeURIComponent(thread)}/comments`, { body });
  }
  react(target: string, kind: string, on: boolean) {
    return this.request<ThreadView>("POST", "/api/reactions", { target, kind, on });
  }
  claim(thread: string) {
    return this.request<{ ok: boolean; claimed_by?: string; error?: string; thread: ThreadView }>("POST", `/api/threads/${encodeURIComponent(thread)}/claim`, {});
  }
  release(thread: string) {
    return this.request<ThreadView>("POST", `/api/threads/${encodeURIComponent(thread)}/release`, {});
  }
  resolve(thread: string) {
    return this.request<ThreadView>("POST", `/api/threads/${encodeURIComponent(thread)}/resolve`, {});
  }
  reopen(thread: string) {
    return this.request<ThreadView>("POST", `/api/threads/${encodeURIComponent(thread)}/reopen`, {});
  }
  subscribe(a: { ws?: string; cwd?: string; globs?: string[] }) {
    return this.request("POST", "/api/subscribe", a);
  }
  attach(a: { kind: "codex"; session?: string; thread?: string; cwd?: string }) {
    return this.request<{ session: string; thread: string; subscriptions: { ws: string; globs: string[] }[]; pending: number }>("POST", "/api/attach", a);
  }
  detach(session?: string) {
    return this.request<{ session: string; detached: boolean }>("POST", "/api/detach", { session });
  }
  unsubscribe(a: { ws?: string; cwd?: string }) {
    return this.request("POST", "/api/unsubscribe", a);
  }
}

export interface Hello {
  type: "hello";
  session: string;
  subscriptions: { ws: string; globs: string[] }[];
  pending: number;
  notes: string[];
}

export interface StreamHandlers {
  hello(h: Hello): void;
  /** deliver the event; resolve when it is safely out (written + flushed, or notified) */
  event(e: EventMsg): Promise<void>;
  /** fatal refusal, e.g. duplicate session name: no reconnect */
  fatal(message: string): void;
  /** transport state for diagnostics (stderr) */
  status?(text: string): void;
}

/**
 * Keep a WebSocket to /api/events open, reconnecting with backoff. Each
 * event is acknowledged only after the handler resolved, so anything lost in
 * between is delivered again on the next connection.
 */
export function streamEvents(
  client: PlanchatClient,
  params: { session: string; cwd: string; transport: "events" | "mcp"; agent?: string },
  h: StreamHandlers,
): { close(): void } {
  let stopped = false;
  let ws: WebSocket | null = null;
  let delay = 500;
  let chain: Promise<void> = Promise.resolve();

  const open = () => {
    if (stopped) return;
    const q = new URLSearchParams({ session: params.session, cwd: params.cwd, transport: params.transport });
    if (params.agent) q.set("agent", params.agent);
    const wsUrl = client.url.replace(/^http/, "ws") + `/api/events?${q}`;
    const headers: Record<string, string> = {};
    const auth = client.headers().authorization;
    if (auth) headers.authorization = auth;
    // Bun's WebSocket takes headers as a second-argument option
    const sock = new WebSocket(wsUrl, { headers } as any);
    ws = sock;
    let fatal = false;
    sock.onopen = () => {
      delay = 500;
      h.status?.("connected");
    };
    sock.onmessage = (m) => {
      let msg: any;
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (msg.type === "hello") h.hello(msg);
      else if (msg.type === "error") {
        fatal = true;
        h.fatal(msg.error);
      } else if (msg.type === "event") {
        chain = chain.then(async () => {
          await h.event(msg);
          if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "ack", ws: msg.ws, seq: msg.seq }));
        });
      }
    };
    sock.onclose = (ev) => {
      ws = null;
      if (stopped || fatal || ev.code === 4009) return;
      h.status?.(`disconnected (${ev.code}${ev.reason ? ` ${ev.reason}` : ""}); retrying in ${delay} ms`);
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    };
    sock.onerror = () => {
      /* onclose follows */
    };
  };
  open();
  const ping = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  }, 30_000);
  return {
    close() {
      stopped = true;
      clearInterval(ping);
      ws?.close(1000, "client exit");
    },
  };
}
