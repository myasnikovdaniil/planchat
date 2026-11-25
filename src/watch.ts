// File watcher: one non-recursive fs.watch per exposed directory, so ignored
// trees (node_modules, build output) cost no inotify watches. Changes are
// debounced per path; a structural change triggers a rescan.

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { FileIndex } from "./files.ts";

export interface WatchHandlers {
  /** a listed file's content may have changed, or it was created or removed */
  onFile(rel: string): void;
  /** the set of listed files changed */
  onTree(): void;
}

export class WorkspaceWatcher {
  private watchers = new Map<string, FSWatcher>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly index: FileIndex,
    private readonly handlers: WatchHandlers,
    private readonly debounceMs: number,
  ) {}

  start(): void {
    this.sync();
  }

  close(): void {
    this.closed = true;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
  }

  /** Bring the watcher set in line with index.dirs. */
  private sync(): void {
    for (const [dir, w] of this.watchers) {
      if (!this.index.dirs.has(dir)) {
        w.close();
        this.watchers.delete(dir);
      }
    }
    for (const dir of this.index.dirs) {
      if (this.watchers.has(dir)) continue;
      const abs = dir ? join(this.index.ws.root, dir) : this.index.ws.root;
      try {
        const w = watch(abs, { persistent: true }, (type, name) => this.onRaw(dir, type, name?.toString() ?? null));
        w.on("error", () => {
          w.close();
          this.watchers.delete(dir);
          this.scheduleRescan();
        });
        this.watchers.set(dir, w);
      } catch {
        /* directory vanished between scan and watch */
      }
    }
  }

  private onRaw(dir: string, type: string, name: string | null): void {
    if (this.closed) return;
    if (!name) {
      this.scheduleRescan();
      return;
    }
    const rel = dir ? `${dir}/${name}` : name;
    if (rel.startsWith(".planchat/") || rel === ".planchat" || rel.includes("/.git/") || rel.startsWith(".git")) return;
    if (type === "rename" || !this.index.files.has(rel)) this.scheduleRescan();
    if (name === ".gitignore") this.scheduleRescan();
    this.scheduleFile(rel);
  }

  private scheduleFile(rel: string): void {
    const t = this.timers.get(rel);
    if (t) clearTimeout(t);
    this.timers.set(
      rel,
      setTimeout(() => {
        this.timers.delete(rel);
        if (!this.closed) this.handlers.onFile(rel);
      }, this.debounceMs),
    );
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      if (this.closed) return;
      const before = this.index.files;
      this.index.scan();
      this.sync();
      const after = this.index.files;
      const changed = before.size !== after.size || [...after].some((f) => !before.has(f));
      if (changed) {
        // files that disappeared get one more onFile so their anchors can be orphaned
        for (const f of before) if (!after.has(f)) this.handlers.onFile(f);
        this.handlers.onTree();
      }
    }, this.debounceMs * 2);
  }
}
