// Append-only event log, tail recovery, content-addressed snapshots and small
// JSON state files. The daemon is the only writer.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ulid } from "./ulid.ts";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type AuthorKind = "human" | "session" | "system";

export interface Author {
  kind: AuthorKind;
  name: string;
}

export interface StoredEvent {
  id: string;
  seq: number;
  ts: string;
  type: string;
  author: Author;
  [key: string]: unknown;
}

export type NewEvent = { type: string; author: Author } & Record<string, unknown>;

export interface RecoveryReport {
  /** records kept */
  records: number;
  /** path the damaged tail was moved to, if any */
  tornPath?: string;
  tornBytes?: number;
}

/** Write a file atomically: temp file in the same directory, fsync, rename. */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export class EventLog {
  readonly path: string;
  private fd: number | null = null;
  private lastSeq = 0;

  constructor(readonly dir: string) {
    this.path = join(dir, "events.jsonl");
  }

  /**
   * Read the log, move a damaged tail aside and open for appending.
   * The valid prefix ends at the first line that is missing its "\n" or does
   * not parse as a JSON object; everything from there on goes to
   * events.jsonl.torn-<ts> and the log is truncated to the prefix.
   */
  open(): { events: StoredEvent[]; report: RecoveryReport } {
    mkdirSync(this.dir, { recursive: true });
    const events: StoredEvent[] = [];
    const report: RecoveryReport = { records: 0 };
    let buf: Buffer = Buffer.alloc(0);
    if (existsSync(this.path)) buf = readFileSync(this.path);
    let goodEnd = 0;
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) break; // torn: no newline
      const line = buf.subarray(pos, nl).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        break;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) break;
      const ev = parsed as StoredEvent;
      if (typeof ev.seq !== "number") ev.seq = events.length + 1;
      events.push(ev);
      goodEnd = nl + 1;
      pos = nl + 1;
    }
    if (goodEnd < buf.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const tornPath = `${this.path}.torn-${stamp}`;
      writeFileAtomic(tornPath, buf.subarray(goodEnd));
      truncateSync(this.path, goodEnd);
      const fd = openSync(this.path, "r+");
      fsyncSync(fd);
      closeSync(fd);
      report.tornPath = tornPath;
      report.tornBytes = buf.length - goodEnd;
    }
    report.records = events.length;
    this.lastSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
    this.fd = openSync(this.path, "a", 0o600);
    return { events, report };
  }

  get seq(): number {
    return this.lastSeq;
  }

  /** Append one event: one line, one write, then fsync. */
  append(ev: NewEvent, now: Date = new Date()): StoredEvent {
    if (this.fd === null) throw new Error("event log is not open");
    const stored = { id: ulid(now.getTime()), seq: this.lastSeq + 1, ts: now.toISOString(), ...ev } as StoredEvent;
    const line = Buffer.from(JSON.stringify(stored) + "\n", "utf8");
    let written = 0;
    while (written < line.length) written += writeSync(this.fd, line, written, line.length - written);
    fsyncSync(this.fd);
    this.lastSeq = stored.seq;
    return stored;
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

/**
 * Content-addressed file versions: .planchat/snapshots/<sha256>, plus an index of
 * the last N hashes per file. A blob is removed only when no file lists it.
 */
export class SnapshotStore {
  private index: Record<string, string[]>;
  private readonly indexPath: string;
  private readonly pinnedPath: string;
  /** versions that recorded changes point at: never pruned */
  private pinned: Set<string>;

  constructor(
    readonly dir: string,
    readonly keep = 20,
  ) {
    mkdirSync(dir, { recursive: true });
    this.indexPath = join(dir, "index.json");
    this.index = readJson<Record<string, string[]>>(this.indexPath, {});
    this.pinnedPath = join(dir, "pinned.json");
    this.pinned = new Set(readJson<string[]>(this.pinnedPath, []));
  }

  /** Keep these versions for good (a thread's change refers to them). */
  pin(...hashes: string[]): void {
    const before = this.pinned.size;
    for (const h of hashes) if (/^[0-9a-f]{64}$/.test(h)) this.pinned.add(h);
    if (this.pinned.size !== before) writeFileAtomic(this.pinnedPath, JSON.stringify([...this.pinned]));
  }

  has(hash: string): boolean {
    return existsSync(join(this.dir, hash));
  }

  get(hash: string): string | null {
    try {
      return readFileSync(join(this.dir, hash), "utf8");
    } catch {
      return null;
    }
  }

  /** Store a version of a file; returns its hash. */
  put(file: string, content: string, hash = sha256(content)): string {
    const blob = join(this.dir, hash);
    if (!existsSync(blob)) writeFileAtomic(blob, content);
    const list = (this.index[file] ?? []).filter((h) => h !== hash);
    list.push(hash);
    const dropped = list.length > this.keep ? list.splice(0, list.length - this.keep) : [];
    this.index[file] = list;
    if (dropped.length) this.prune(dropped);
    writeFileAtomic(this.indexPath, JSON.stringify(this.index));
    return hash;
  }

  /** Hashes kept for a file, oldest first. */
  versions(file: string): string[] {
    return this.index[file] ?? [];
  }

  private prune(candidates: string[]): void {
    const live = new Set([...Object.values(this.index).flat(), ...this.pinned]);
    for (const h of candidates) if (!live.has(h)) rmSync(join(this.dir, h), { force: true });
  }

  /** Remove blobs no file references (e.g. after a crash between writes). */
  gc(): void {
    const live = new Set([...Object.values(this.index).flat(), ...this.pinned]);
    for (const name of readdirSync(this.dir)) {
      if (/^[0-9a-f]{64}$/.test(name) && !live.has(name)) rmSync(join(this.dir, name), { force: true });
    }
  }
}
