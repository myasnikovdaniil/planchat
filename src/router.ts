// Subscriptions, thread audience, claim rules and at-least-once delivery
// bookkeeping (per-session cursors and pending queues) for one workspace.

import type { ReactionType } from "./config.ts";
import type { StoredEvent } from "./store.ts";
import type { Audience, Thread } from "./state.ts";

export interface Subscription {
  session: string;
  globs: string[];
  /** seq of the last event the session confirmed */
  cursor: number;
}

const MENTION_RE = /(^|[\s([{,;:"'«])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g;

/** `@name` mentions in a comment body, in order, without duplicates. */
export function parseMentions(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const name = m[2].replace(/[.\-_]+$/, "");
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Audience of a new thread: its mentions, or everyone subscribed to the file. */
export function audienceForRoot(body: string): Audience {
  const m = parseMentions(body);
  return m.length ? m : "*";
}

/**
 * Audience after a human comment: replaced by the comment's mentions when
 * they name someone outside the current audience, otherwise unchanged.
 * Returns undefined when nothing changes.
 */
export function audienceAfterComment(current: Audience, body: string): Audience | undefined {
  const m = parseMentions(body);
  if (!m.length) return undefined;
  if (current !== "*" && m.every((n) => current.includes(n))) return undefined;
  return m;
}

const globCache = new Map<string, InstanceType<typeof Bun.Glob>>();
function glob(pattern: string) {
  let g = globCache.get(pattern);
  if (!g) {
    g = new Bun.Glob(pattern);
    globCache.set(pattern, g);
  }
  return g;
}

export function matchesAny(globs: string[], path: string): boolean {
  return globs.some((p) => glob(p).match(path));
}

export function subscribedTo(sub: Subscription | undefined, file: string): boolean {
  return !!sub && matchesAny(sub.globs, file);
}

/** Subscribed to the thread's file and either named in the audience or the audience is everyone. */
export function inAudience(thread: Thread, session: string, subs: Map<string, Subscription>): boolean {
  if (!subscribedTo(subs.get(session), thread.file)) return false;
  return thread.audience === "*" || thread.audience.includes(session);
}

export type ClaimCheck = { ok: true } | { ok: false; error: string; claimed_by?: string };

export function canClaim(thread: Thread, session: string, subs: Map<string, Subscription>): ClaimCheck {
  if (thread.status !== "open") return { ok: false, error: "thread is resolved" };
  if (!inAudience(thread, session, subs)) return { ok: false, error: `session ${session} is not in the thread's audience` };
  if (thread.claim && thread.claim.session !== session) {
    return { ok: false, error: `claimed by ${thread.claim.session}`, claimed_by: thread.claim.session };
  }
  return { ok: true };
}

/** seq of the latest human input on a thread: a comment or a trigger reaction. */
export function lastHumanInput(thread: Thread, reactionType: (kind: string) => ReactionType | undefined): number {
  let last = 0;
  for (const c of thread.comments) {
    if (c.author.kind === "human" && !c.deleted) last = Math.max(last, c.seq);
    for (const r of c.reactions) if (r.author.kind === "human" && reactionType(r.kind) === "trigger") last = Math.max(last, r.seq);
  }
  return last;
}

/** Sessions that already commented on the thread after the latest human input. */
export function answeredSince(thread: Thread, since: number): Set<string> {
  const out = new Set<string>();
  for (const c of thread.comments) if (c.author.kind === "session" && c.seq > since) out.add(c.author.name);
  return out;
}

/**
 * Sessions an event wakes, given the thread state after the event.
 *  - new thread, comment, or trigger reaction from a human;
 *  - release by a human: the whole audience;
 *  - release by the owner: the rest of the audience, minus sessions that
 *    already answered the latest human input (otherwise two sessions that
 *    reply and release bounce the thread between each other forever);
 *  - never: anything a session or the daemon did, signal reactions,
 *    resolved threads. A claimed thread only reaches its owner.
 */
export function recipients(
  ev: StoredEvent,
  thread: Thread | undefined,
  subs: Map<string, Subscription>,
  reactionType: (kind: string) => ReactionType | undefined,
): string[] {
  if (!thread || thread.status !== "open") return [];
  const exclude = new Set<string>();
  if (ev.type === "thread.release") {
    const reason = ev.reason as string;
    if (reason !== "explicit" && reason !== "human") return [];
    if (ev.author.kind === "session") {
      exclude.add(ev.author.name);
      for (const n of answeredSince(thread, lastHumanInput(thread, reactionType))) exclude.add(n);
    }
  } else {
    if (ev.author.kind !== "human") return [];
    const wakes =
      ev.type === "thread.create" ||
      ev.type === "comment.add" ||
      (ev.type === "reaction.set" && reactionType(String(ev.kind)) === "trigger");
    if (!wakes) return [];
  }
  let names = [...subs.keys()].filter((n) => inAudience(thread, n, subs));
  if (thread.claim) names = names.filter((n) => n === thread.claim!.session);
  return names.filter((n) => !exclude.has(n));
}

/** Per-session cursors and the queue of addressed, unconfirmed events. */
export class Delivery {
  readonly subs = new Map<string, Subscription>();
  private readonly pending = new Map<string, number[]>();

  constructor(
    initial: Subscription[],
    private readonly save: (subs: Subscription[]) => void,
  ) {
    for (const s of initial) this.subs.set(s.session, { ...s });
  }

  list(): Subscription[] {
    return [...this.subs.values()];
  }

  /** New subscriptions start at the current head: no backlog from before they existed. */
  subscribe(session: string, globs: string[], head: number): Subscription {
    const existing = this.subs.get(session);
    const sub = existing ? { ...existing, globs } : { session, globs, cursor: head };
    this.subs.set(session, sub);
    this.save(this.list());
    return sub;
  }

  unsubscribe(session: string): void {
    this.subs.delete(session);
    this.pending.delete(session);
    this.save(this.list());
  }

  record(seq: number, names: string[]): void {
    for (const n of names) {
      const sub = this.subs.get(n);
      if (!sub || seq <= sub.cursor) continue;
      const q = this.pending.get(n) ?? [];
      if (q[q.length - 1] !== seq) q.push(seq);
      this.pending.set(n, q);
    }
  }

  pendingFor(session: string): number[] {
    return [...(this.pending.get(session) ?? [])];
  }

  /** Drop an addressed event that is no longer deliverable (thread resolved or taken). */
  drop(session: string, seq: number): void {
    const q = this.pending.get(session);
    if (q) this.pending.set(session, q.filter((s) => s !== seq));
  }

  ack(session: string, seq: number): boolean {
    const sub = this.subs.get(session);
    if (!sub || seq <= sub.cursor) return false;
    sub.cursor = seq;
    const q = this.pending.get(session);
    if (q) this.pending.set(session, q.filter((s) => s > seq));
    this.save(this.list());
    return true;
  }
}

/** A claim is stale when its owner has been offline longer than the grace period. */
export function claimIsStale(
  thread: Thread,
  presence: (session: string) => { online: boolean; lastSeen: number } | undefined,
  now: number,
  graceMs: number,
): boolean {
  if (!thread.claim) return false;
  const p = presence(thread.claim.session);
  if (p?.online) return false;
  const since = p?.lastSeen ?? 0;
  return now - since > graceMs;
}

/** Whether an addressed event should still go out to this session now. */
export function stillDeliverable(thread: Thread | undefined, session: string): boolean {
  if (!thread || thread.status !== "open") return false;
  if (thread.claim && thread.claim.session !== session) return false;
  return true;
}
