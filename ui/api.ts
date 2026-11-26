// Browser-side API client. Auth rides on the HttpOnly cookie.

import type { ThreadView } from "../src/hub.ts";
import type { ReactionDef } from "../src/config.ts";
import type { Author } from "../src/store.ts";
import type { LineDiff } from "../src/linediff.ts";

export type { ThreadView, ReactionDef, Author, LineDiff };

export interface Me {
  author: Author;
  reactions: ReactionDef[];
  workspaces: { name: string; root: string }[];
  graceSeconds: number;
}

export interface SessionInfo {
  name: string;
  online: boolean;
  lastSeen: number;
  transport?: string;
  subscriptions: { ws: string; globs: string[]; cursor: number }[];
}

export interface FileList {
  ws: string;
  files: string[];
  threads: Record<string, { open: number; total: number }>;
  /** present when the list was narrowed to one session's subscription */
  scope?: { session: string; globs: string[] };
}

export interface FileContent {
  ws: string;
  path: string;
  content: string;
  hash: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? `HTTP ${res.status}`);
  return data as T;
}

const q = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) p.set(k, v);
  return p.toString();
};

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  sessions: () => call<SessionInfo[]>("GET", "/api/sessions"),
  files: (ws: string, session?: string) => call<FileList>("GET", `/api/files?${q({ ws, session })}`),
  file: (ws: string, path: string) => call<FileContent>("GET", `/api/file?${q({ ws, path })}`),
  threads: (ws: string) => call<ThreadView[]>("GET", `/api/threads?${q({ ws, status: "all" })}`),
  create: (ws: string, file: string, anchor: { start: number; end: number; baseHash: string }, body: string) =>
    call<ThreadView>("POST", "/api/threads", { ws, file, anchor, body }),
  reply: (id: string, body: string) => call<ThreadView>("POST", `/api/threads/${id}/comments`, { body }),
  react: (target: string, kind: string, on: boolean) => call<ThreadView>("POST", "/api/reactions", { target, kind, on }),
  release: (id: string) => call<ThreadView>("POST", `/api/threads/${id}/release`, {}),
  resolve: (id: string) => call<ThreadView>("POST", `/api/threads/${id}/resolve`, {}),
  reopen: (id: string) => call<ThreadView>("POST", `/api/threads/${id}/reopen`, {}),
  moveAnchor: (id: string, anchor: { start: number; end: number; baseHash: string }) =>
    call<ThreadView>("POST", `/api/threads/${id}/anchor`, { anchor }),
  editComment: (id: string, body: string) => call<ThreadView>("PATCH", `/api/comments/${id}`, { body }),
  deleteComment: (id: string) => call<ThreadView>("DELETE", `/api/comments/${id}`),
  diff: (ws: string, from: string, to: string) => call<LineDiff>("GET", `/api/diff?${q({ ws, from, to })}`),
};

export type StreamMsg =
  | { type: "event"; ws: string; event: { type: string; thread?: string; seq: number } }
  | { type: "file"; ws: string; path: string; hash: string | null }
  | { type: "tree"; ws: string }
  | { type: "sessions" };

/** SSE with a callback per message and one on (re)open, so the caller can resync after a gap. */
export function stream(ws: string, onMsg: (m: StreamMsg) => void, onOpen: () => void): () => void {
  const es = new EventSource(`/api/stream?${q({ ws })}`);
  for (const type of ["event", "file", "tree", "sessions"]) {
    es.addEventListener(type, (e) => {
      try {
        onMsg(JSON.parse((e as MessageEvent).data));
      } catch {
        /* ignore malformed */
      }
    });
  }
  es.addEventListener("hello", () => onOpen());
  return () => es.close();
}
