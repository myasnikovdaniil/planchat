// In-memory state of one workspace, rebuilt by replaying the event log.
// The reducer is permissive: permission checks happen before an event is
// appended, so replay never rejects what the log already holds.

import type { Anchor } from "./anchor.ts";
import type { Author, StoredEvent } from "./store.ts";

export type Audience = "*" | string[];

export interface Reaction {
  kind: string;
  author: Author;
  ts: string;
  seq: number;
}

/** A change of the thread's file between two recorded versions (snapshot hashes). */
export interface Change {
  file: string;
  from: string;
  to: string;
  /** filled in by the daemon for views: lines added and removed; null when a version is gone */
  stats?: { added: number; removed: number } | null;
}

export interface Comment {
  id: string;
  author: Author;
  body: string;
  ts: string;
  /** seq of the event that added the comment */
  seq: number;
  edited?: string;
  deleted?: boolean;
  reactions: Reaction[];
  /** for a session's comment: how the file changed since the previous point of the thread */
  change?: Change;
}

export interface Claim {
  session: string;
  ts: string;
}

export interface Thread {
  id: string;
  file: string;
  anchor: Anchor;
  /** the anchored text when the thread was created */
  quote: string;
  audience: Audience;
  status: "open" | "resolved";
  claim: Claim | null;
  /** comments[0] is the root comment; its id equals the thread id */
  comments: Comment[];
  author: Author;
  created: string;
  updated: string;
  /** seq of the last event that touched the thread */
  seq: number;
  /** file version at the last recorded point (creation, claim, comment, resolve) */
  lastHash?: string;
  resolved?: { by: Author; ts: string; change?: Change };
}

export class State {
  readonly threads = new Map<string, Thread>();
  /** comment id -> thread id */
  readonly commentIndex = new Map<string, string>();

  thread(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  /** Thread that owns a comment id or a thread id. */
  threadOf(targetId: string): Thread | undefined {
    const tid = this.commentIndex.get(targetId);
    return tid ? this.threads.get(tid) : undefined;
  }

  byFile(file: string): Thread[] {
    return [...this.threads.values()].filter((t) => t.file === file);
  }

  apply(ev: StoredEvent): Thread | undefined {
    const tid = ev.thread as string | undefined;
    if (ev.type === "thread.create") {
      if (!tid || this.threads.has(tid)) return undefined;
      const anchor = ev.anchor as Anchor;
      const root: Comment = { id: tid, author: ev.author, body: String(ev.body ?? ""), ts: ev.ts, seq: ev.seq, reactions: [] };
      const t: Thread = {
        id: tid,
        file: anchor.file,
        anchor,
        quote: anchor.exact,
        audience: (ev.audience as Audience) ?? "*",
        status: "open",
        claim: null,
        comments: [root],
        author: ev.author,
        created: ev.ts,
        updated: ev.ts,
        seq: ev.seq,
        lastHash: anchor.fileHash,
      };
      this.threads.set(tid, t);
      this.commentIndex.set(tid, tid);
      return t;
    }
    const t = tid ? this.threads.get(tid) : undefined;
    if (!t) return undefined;
    t.updated = ev.ts;
    t.seq = ev.seq;
    switch (ev.type) {
      case "comment.add": {
        const id = ev.comment as string;
        if (this.commentIndex.has(id)) break;
        const c: Comment = { id, author: ev.author, body: String(ev.body ?? ""), ts: ev.ts, seq: ev.seq, reactions: [] };
        const change = this.checkpoint(t, ev);
        if (change) c.change = change;
        t.comments.push(c);
        this.commentIndex.set(id, t.id);
        if (ev.audience !== undefined) t.audience = ev.audience as Audience;
        break;
      }
      case "comment.edit": {
        const c = t.comments.find((x) => x.id === ev.comment);
        if (c && !c.deleted) {
          c.body = String(ev.body ?? "");
          c.edited = ev.ts;
        }
        break;
      }
      case "comment.delete": {
        const c = t.comments.find((x) => x.id === ev.comment);
        if (c) {
          c.deleted = true;
          c.body = "";
        }
        break;
      }
      case "reaction.set":
      case "reaction.unset": {
        const c = t.comments.find((x) => x.id === ev.target);
        if (!c) break;
        const kind = String(ev.kind);
        const same = (r: Reaction) => r.kind === kind && r.author.kind === ev.author.kind && r.author.name === ev.author.name;
        if (ev.type === "reaction.set") {
          if (!c.reactions.some(same)) c.reactions.push({ kind, author: ev.author, ts: ev.ts, seq: ev.seq });
        } else {
          c.reactions = c.reactions.filter((r) => !same(r));
        }
        break;
      }
      case "thread.resolve": {
        t.status = "resolved";
        const change = this.checkpoint(t, ev);
        t.resolved = { by: ev.author, ts: ev.ts, ...(change ? { change } : {}) };
        break;
      }
      case "thread.reopen":
        t.status = "open";
        t.resolved = undefined;
        break;
      case "thread.claim":
        t.claim = { session: String(ev.session), ts: ev.ts };
        this.checkpoint(t, ev);
        break;
      case "thread.release":
        t.claim = null;
        break;
      case "anchor.update":
        t.anchor = ev.anchor as Anchor;
        t.file = t.anchor.file;
        break;
    }
    return t;
  }

  /**
   * Move the thread's file checkpoint to the version an event recorded
   * (ev.fileHash). For a session's event, the step from the previous
   * checkpoint is the change that session made (or at least saw happen).
   */
  private checkpoint(t: Thread, ev: StoredEvent): Change | undefined {
    const to = ev.fileHash as string | undefined;
    if (!to) return undefined;
    const from = t.lastHash;
    t.lastHash = to;
    if (ev.author.kind !== "session" || !from || from === to) return undefined;
    return { file: t.file, from, to };
  }

  /** Every change recorded in the state (to keep their snapshots). */
  changes(): Change[] {
    const out: Change[] = [];
    for (const t of this.threads.values()) {
      for (const c of t.comments) if (c.change) out.push(c.change);
      if (t.resolved?.change) out.push(t.resolved.change);
    }
    return out;
  }
}

/** All reactions on a thread (root and replies), newest state. */
export function allReactions(t: Thread): { target: string; reaction: Reaction }[] {
  return t.comments.flatMap((c) => c.reactions.map((reaction) => ({ target: c.id, reaction })));
}
