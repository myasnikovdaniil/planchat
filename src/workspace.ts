// One workspace: its event log, state, snapshots, delivery queues and file
// watcher, plus every mutating operation with its permission checks.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AnchorError,
  countOccurrences,
  makeAnchor,
  rangeOfExact,
  reanchor,
  translateSelection,
  type Anchor,
} from "./anchor.ts";
import type { ReactionDef, ReactionType, WorkspaceConfig } from "./config.ts";
import { FileIndex, readText } from "./files.ts";
import {
  audienceAfterComment,
  audienceForRoot,
  canClaim,
  Delivery,
  recipients,
  stillDeliverable,
  type Subscription,
} from "./router.ts";
import { State, type Thread } from "./state.ts";
import { EventLog, readJson, sha256, SnapshotStore, writeFileAtomic, type Author, type NewEvent, type RecoveryReport, type StoredEvent } from "./store.ts";
import { ulid } from "./ulid.ts";
import { WorkspaceWatcher } from "./watch.ts";

export class OpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface WorkspaceSettings {
  snapshots: number;
  quoteThreshold: number;
  debounceMs: number;
  reactions: ReactionDef[];
}

export interface WorkspaceHooks {
  appended(ws: Workspace, ev: StoredEvent, recipients: string[]): void;
  fileChanged(ws: Workspace, path: string, hash: string | null): void;
  treeChanged(ws: Workspace): void;
}

export type AnchorInput = { start: number; end: number; baseHash?: string } | { exact: string; nth?: number };

const SYSTEM: Author = { kind: "system", name: "planchat" };
const MAX_BODY = 64 * 1024;

function checkBody(body: unknown): string {
  if (typeof body !== "string" || !body.trim()) throw new OpError(400, "bad_request", "body is required");
  if (body.length > MAX_BODY) throw new OpError(413, "too_large", `body is longer than ${MAX_BODY} characters`);
  return body;
}

export class Workspace {
  readonly name: string;
  readonly root: string;
  readonly index: FileIndex;
  readonly state = new State();
  readonly events = new Map<number, StoredEvent>();
  readonly snapshots: SnapshotStore;
  readonly delivery: Delivery;
  private readonly log: EventLog;
  private readonly dir: string;
  private watcher: WorkspaceWatcher | null = null;
  private readonly hashes = new Map<string, string>();

  constructor(
    readonly cfg: WorkspaceConfig,
    private readonly settings: WorkspaceSettings,
    private readonly hooks: WorkspaceHooks,
  ) {
    this.name = cfg.name;
    this.root = cfg.root;
    this.dir = join(cfg.root, ".planchat");
    mkdirSync(this.dir, { recursive: true });
    this.index = new FileIndex(cfg);
    this.log = new EventLog(this.dir);
    this.snapshots = new SnapshotStore(join(this.dir, "snapshots"), settings.snapshots);
    const saved = readJson<Record<string, { globs: string[]; cursor: number }>>(join(this.dir, "cursors.json"), {});
    const subs = Object.entries(saved).map(([session, s]) => ({ session, globs: s.globs, cursor: s.cursor }));
    this.delivery = new Delivery(subs, (list) => this.saveCursors(list));
  }

  private saveCursors(list: Subscription[]): void {
    const out: Record<string, { globs: string[]; cursor: number }> = {};
    for (const s of list) out[s.session] = { globs: s.globs, cursor: s.cursor };
    writeFileAtomic(join(this.dir, "cursors.json"), JSON.stringify(out, null, 1));
  }

  get head(): number {
    return this.log.seq;
  }

  reactionType = (kind: string): ReactionType | undefined => this.settings.reactions.find((r) => r.kind === kind)?.type;

  /** Replay the log, rebuild delivery queues, catch up anchors with files changed while the daemon was down. */
  open(): RecoveryReport {
    this.index.scan();
    const { events, report } = this.log.open();
    for (const ev of events) {
      this.events.set(ev.seq, ev);
      const t = this.state.apply(ev);
      this.delivery.record(ev.seq, recipients(ev, t, this.delivery.subs, this.reactionType));
    }
    for (const c of this.state.changes()) this.snapshots.pin(c.from, c.to);
    this.snapshots.gc();
    const files = new Set([...this.state.threads.values()].map((t) => t.file));
    for (const f of files) this.reanchorFile(f);
    return report;
  }

  startWatching(): void {
    this.watcher = new WorkspaceWatcher(
      this.index,
      {
        onFile: (rel) => this.reanchorFile(rel),
        onTree: () => this.hooks.treeChanged(this),
      },
      this.settings.debounceMs,
    );
    this.watcher.start();
  }

  close(): void {
    this.watcher?.close();
    this.log.close();
  }

  private append(ev: NewEvent): StoredEvent {
    const stored = this.log.append(ev);
    this.events.set(stored.seq, stored);
    const t = this.state.apply(stored);
    if (t && stored.fileHash) {
      // keep both versions of whatever change this event recorded
      const c = stored.type === "comment.add" ? t.comments.find((x) => x.id === stored.comment)?.change : stored.type === "thread.resolve" ? t.resolved?.change : undefined;
      if (c) this.snapshots.pin(c.from, c.to);
    }
    const names = recipients(stored, t, this.delivery.subs, this.reactionType);
    this.delivery.record(stored.seq, names);
    this.hooks.appended(this, stored, names);
    return stored;
  }

  // ------------------------------------------------------------------ files

  /** Current text of a listed file. */
  read(rel: string): { content: string; hash: string } {
    const abs = this.index.resolve(rel);
    if (!abs) throw new OpError(404, "not_found", `file ${rel} is not in workspace ${this.name}`);
    const r = readText(abs);
    if (!r.ok) throw new OpError(r.error === "missing" ? 404 : 415, r.error, `file ${rel}: ${r.error}`);
    return { content: r.content, hash: sha256(r.content) };
  }

  /** Read for display: the version the viewer sees is snapshotted so later selections on it can be translated. */
  view(rel: string): { content: string; hash: string } {
    const f = this.read(rel);
    this.snapshots.put(rel, f.content, f.hash);
    this.hashes.set(rel, f.hash);
    return f;
  }

  /** Snapshot the file as it is now and return its hash; undefined when it cannot be read. */
  private version(rel: string): string | undefined {
    try {
      const f = this.read(rel);
      this.snapshots.put(rel, f.content, f.hash);
      return f.hash;
    } catch {
      return undefined;
    }
  }

  tryRead(rel: string): string | null {
    try {
      return this.read(rel).content;
    } catch {
      return null;
    }
  }

  /** Re-anchor every thread on a file after it changed (or vanished). */
  reanchorFile(rel: string): void {
    const threads = this.state.byFile(rel);
    let f: { content: string; hash: string } | null = null;
    try {
      f = this.read(rel);
    } catch {
      f = null;
    }
    if (!f) {
      for (const t of threads) {
        if (t.anchor.state === "orphaned") continue;
        this.append({ type: "anchor.update", author: SYSTEM, thread: t.id, anchor: { ...t.anchor, state: "orphaned", reason: "file-deleted" } });
      }
      if (this.hashes.has(rel)) {
        this.hashes.delete(rel);
        this.hooks.fileChanged(this, rel, null);
      }
      return;
    }
    const prev = this.hashes.get(rel);
    const tracked = threads.length > 0 || this.snapshots.versions(rel).length > 0;
    if (!tracked && prev === undefined) return; // never viewed, no threads: nobody cares
    if (tracked) this.snapshots.put(rel, f.content, f.hash);
    for (const t of threads) {
      if (t.anchor.state === "orphaned" || t.anchor.fileHash === f.hash) continue;
      const old = this.snapshots.get(t.anchor.fileHash);
      const next = reanchor(t.anchor, old, f.content, f.hash, this.settings.quoteThreshold);
      if (JSON.stringify(next) !== JSON.stringify(t.anchor)) {
        this.append({ type: "anchor.update", author: SYSTEM, thread: t.id, anchor: next });
      }
    }
    this.hashes.set(rel, f.hash);
    if (prev !== f.hash) this.hooks.fileChanged(this, rel, f.hash);
  }

  // ------------------------------------------------------------- threads

  thread(id: string): Thread {
    const t = this.state.thread(id);
    if (!t) throw new OpError(404, "not_found", `thread ${id} not found`);
    return t;
  }

  private anchorFor(file: string, input: AnchorInput, current: { content: string; hash: string }): Anchor {
    const { content, hash } = current;
    let start: number;
    let end: number;
    if ("exact" in input) {
      if (typeof input.exact !== "string" || !input.exact) throw new OpError(400, "bad_request", "anchor.exact is empty");
      const n = countOccurrences(content, input.exact);
      if (n === 0) throw new OpError(404, "not_found", `text not found in ${file}`);
      if (input.nth === undefined && n > 1) {
        throw new OpError(409, "ambiguous", `text occurs ${n} times in ${file}; pass nth (0-based)`, { occurrences: n });
      }
      const r = rangeOfExact(content, input.exact, input.nth ?? 0);
      if (!r) throw new OpError(404, "not_found", `occurrence ${input.nth} not found (text occurs ${n} times)`, { occurrences: n });
      ({ start, end } = r);
    } else {
      ({ start, end } = input);
      if (input.baseHash && input.baseHash !== hash) {
        const base = this.snapshots.get(input.baseHash);
        if (base === null) {
          throw new OpError(409, "stale", "the file changed and the version the selection was made on is gone; select again", { hash });
        }
        const moved = translateSelection(base, content, start, end);
        if (!moved) {
          throw new OpError(409, "stale", "the file changed under the selection; select again on the fresh version", { hash });
        }
        ({ start, end } = moved);
      }
    }
    try {
      return makeAnchor(file, content, start, end, hash);
    } catch (e) {
      if (e instanceof AnchorError) throw new OpError(400, "bad_range", e.message);
      throw e;
    }
  }

  createThread(actor: Author, input: { file: string; anchor: AnchorInput; body: string }): Thread {
    const body = checkBody(input.body);
    if (!input.anchor || typeof input.anchor !== "object") throw new OpError(400, "bad_request", "anchor is required");
    const current = this.read(input.file);
    const anchor = this.anchorFor(input.file, input.anchor, current);
    this.snapshots.put(input.file, current.content, current.hash);
    this.hashes.set(input.file, current.hash);
    const id = ulid();
    this.append({ type: "thread.create", author: actor, thread: id, anchor, body, audience: audienceForRoot(body) });
    return this.thread(id);
  }

  reply(actor: Author, threadId: string, bodyIn: string): Thread {
    const body = checkBody(bodyIn);
    const t = this.thread(threadId);
    const ev: NewEvent = { type: "comment.add", author: actor, thread: t.id, comment: ulid(), body };
    const fileHash = this.version(t.file);
    if (fileHash) ev.fileHash = fileHash;
    if (actor.kind === "human") {
      const next = audienceAfterComment(t.audience, body);
      if (next) ev.audience = next;
    }
    this.append(ev);
    return t;
  }

  private ownComment(actor: Author, commentId: string): { t: Thread; id: string } {
    const t = this.state.threadOf(commentId);
    if (!t) throw new OpError(404, "not_found", `comment ${commentId} not found`);
    const c = t.comments.find((x) => x.id === commentId)!;
    if (c.deleted) throw new OpError(409, "deleted", "comment is deleted");
    if (c.author.kind !== actor.kind || c.author.name !== actor.name) throw new OpError(403, "forbidden", "only the author can change a comment");
    return { t, id: commentId };
  }

  editComment(actor: Author, commentId: string, bodyIn: string): Thread {
    const body = checkBody(bodyIn);
    const { t, id } = this.ownComment(actor, commentId);
    this.append({ type: "comment.edit", author: actor, thread: t.id, comment: id, body });
    return t;
  }

  deleteComment(actor: Author, commentId: string): Thread {
    const { t, id } = this.ownComment(actor, commentId);
    if (id === t.id) throw new OpError(400, "bad_request", "the root comment cannot be deleted; resolve the thread instead");
    this.append({ type: "comment.delete", author: actor, thread: t.id, comment: id });
    return t;
  }

  react(actor: Author, targetId: string, kind: string, on: boolean): Thread {
    if (!this.reactionType(kind)) throw new OpError(400, "bad_request", `unknown reaction ${kind}; known: ${this.settings.reactions.map((r) => r.kind).join(", ")}`);
    const t = this.state.threadOf(targetId);
    if (!t) throw new OpError(404, "not_found", `thread or comment ${targetId} not found`);
    const c = t.comments.find((x) => x.id === targetId)!;
    const has = c.reactions.some((r) => r.kind === kind && r.author.kind === actor.kind && r.author.name === actor.name);
    if (on !== has) this.append({ type: on ? "reaction.set" : "reaction.unset", author: actor, thread: t.id, target: targetId, kind });
    return t;
  }

  claim(actor: Author, threadId: string): { thread: Thread; ok: boolean; claimed_by?: string; error?: string } {
    if (actor.kind !== "session") throw new OpError(400, "bad_request", "only a session can claim a thread");
    const t = this.thread(threadId);
    const check = canClaim(t, actor.name, this.delivery.subs);
    if (!check.ok) {
      if (check.claimed_by) return { thread: t, ok: false, claimed_by: check.claimed_by, error: check.error };
      throw new OpError(403, "forbidden", check.error);
    }
    if (t.claim?.session !== actor.name) {
      const fileHash = this.version(t.file);
      this.append({ type: "thread.claim", author: actor, thread: t.id, session: actor.name, ...(fileHash ? { fileHash } : {}) });
    }
    if (this.reactionType("seen")) this.react(actor, t.id, "seen", true);
    return { thread: t, ok: true };
  }

  release(actor: Author, threadId: string): Thread {
    const t = this.thread(threadId);
    if (!t.claim) return t;
    if (actor.kind === "session") {
      if (t.claim.session !== actor.name) throw new OpError(403, "forbidden", `claimed by ${t.claim.session}, not ${actor.name}`);
      this.append({ type: "thread.release", author: actor, thread: t.id, session: actor.name, reason: "explicit" });
    } else {
      this.append({ type: "thread.release", author: actor, thread: t.id, session: t.claim.session, reason: "human" });
    }
    return t;
  }

  resolve(actor: Author, threadId: string): Thread {
    const t = this.thread(threadId);
    if (t.status === "resolved") return t;
    if (actor.kind === "session" && t.claim?.session !== actor.name) {
      throw new OpError(403, "forbidden", "a session resolves only a thread it has claimed");
    }
    const owner = t.claim?.session;
    const fileHash = this.version(t.file);
    this.append({ type: "thread.resolve", author: actor, thread: t.id, ...(fileHash ? { fileHash } : {}) });
    if (owner) this.append({ type: "thread.release", author: actor, thread: t.id, session: owner, reason: "resolved" });
    return t;
  }

  reopen(actor: Author, threadId: string): Thread {
    const t = this.thread(threadId);
    if (t.status === "open") return t;
    this.append({ type: "thread.reopen", author: actor, thread: t.id });
    return t;
  }

  /** A human puts a (usually orphaned) thread on a new selection. */
  moveAnchor(actor: Author, threadId: string, input: AnchorInput): Thread {
    if (actor.kind !== "human") throw new OpError(403, "forbidden", "only a human re-anchors a thread");
    const t = this.thread(threadId);
    const current = this.read(t.file);
    const anchor = this.anchorFor(t.file, input, current);
    this.snapshots.put(t.file, current.content, current.hash);
    this.append({ type: "anchor.update", author: actor, thread: t.id, anchor });
    return t;
  }

  // ------------------------------------------------------------ delivery

  subscribe(session: string, globs: string[]): Subscription {
    for (const g of globs) {
      try {
        new Bun.Glob(g);
      } catch {
        throw new OpError(400, "bad_request", `bad glob ${g}`);
      }
    }
    return this.delivery.subscribe(session, globs.length ? globs : ["**"], this.head);
  }

  /** Events addressed to a session and still worth sending, oldest first. */
  backlog(session: string): StoredEvent[] {
    const out: StoredEvent[] = [];
    for (const seq of this.delivery.pendingFor(session)) {
      const ev = this.events.get(seq);
      const t = ev ? this.state.thread(String(ev.thread)) : undefined;
      if (!ev || !stillDeliverable(t, session)) {
        this.delivery.drop(session, seq);
        continue;
      }
      out.push(ev);
    }
    return out;
  }

  deliverable(session: string, ev: StoredEvent): boolean {
    const ok = stillDeliverable(this.state.thread(String(ev.thread)), session);
    if (!ok) this.delivery.drop(session, ev.seq);
    return ok;
  }
}
