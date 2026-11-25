// The set of files a workspace exposes: include/exclude globs plus every
// .gitignore on the way down. Paths are relative to the root, "/"-separated.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { DEFAULT_EXCLUDE, type WorkspaceConfig } from "./config.ts";
import { matchesAny } from "./router.ts";

export const MAX_FILE_BYTES = 4 * 1024 * 1024;

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|bmp|ico|icns|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|tar|jar|war|class|so|dylib|dll|exe|bin|o|a|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|mkv|webm|ogg|flac|wav|sqlite|db|pyc)$/i;

const SKIP_DIRS = new Set([".git", ".planchat", "node_modules"]);

interface Level {
  dir: string; // relative, "" for root
  ig: Ignore;
}

export class FileIndex {
  files = new Set<string>();
  dirs = new Set<string>();
  private readonly realRoot: string;

  constructor(readonly ws: WorkspaceConfig) {
    this.realRoot = realpathSync(ws.root);
  }

  private excluded(rel: string, isDir: boolean): boolean {
    const ex = [...DEFAULT_EXCLUDE, ...this.ws.exclude];
    if (isDir) {
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      if (SKIP_DIRS.has(name)) return true;
      // "build/**" or "**/vendor/**" exclude the directory itself
      return matchesAny(ex, `${rel}/x`) || matchesAny(ex, rel);
    }
    return matchesAny(ex, rel) || !matchesAny(this.ws.include, rel);
  }

  scan(): void {
    const files = new Set<string>();
    const dirs = new Set<string>([""]);
    const walk = (relDir: string, levels: Level[]) => {
      const abs = relDir ? join(this.ws.root, relDir) : this.ws.root;
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      let here = levels;
      if (entries.some((e) => e.name === ".gitignore" && e.isFile())) {
        try {
          here = [...levels, { dir: relDir, ig: ignore().add(readFileSync(join(abs, ".gitignore"), "utf8")) }];
        } catch {
          /* unreadable .gitignore: ignore it */
        }
      }
      const ignored = (rel: string, isDir: boolean) =>
        here.some((l) => {
          const sub = l.dir ? rel.slice(l.dir.length + 1) : rel;
          return l.ig.ignores(isDir ? `${sub}/` : sub);
        });
      for (const e of entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue; // never follow links out of the root
        if (e.isDirectory()) {
          if (this.excluded(rel, true) || ignored(rel, true)) continue;
          dirs.add(rel);
          walk(rel, here);
        } else if (e.isFile()) {
          if (BINARY_EXT.test(e.name) || this.excluded(rel, false) || ignored(rel, false)) continue;
          files.add(rel);
        }
      }
    };
    walk("", []);
    this.files = files;
    this.dirs = dirs;
  }

  list(): string[] {
    return [...this.files].sort();
  }

  /** Absolute path of a listed file, or null if the path is not exposed. */
  resolve(rel: string): string | null {
    if (!rel || rel.includes("\0") || isAbsolute(rel)) return null;
    const norm = normalize(rel).split(sep).join("/");
    if (norm.startsWith("../") || norm === ".." || norm !== rel) return null;
    if (!this.files.has(rel)) return null;
    const abs = join(this.ws.root, rel);
    try {
      const real = realpathSync(abs);
      if (!real.startsWith(this.realRoot + sep)) return null;
      if (!statSync(real).isFile()) return null;
    } catch {
      return null;
    }
    return abs;
  }

  relativeOf(abs: string): string {
    return relative(this.ws.root, abs).split(sep).join("/");
  }
}

export type ReadResult = { ok: true; content: string } | { ok: false; error: "missing" | "binary" | "too-large" };

export function readText(abs: string): ReadResult {
  let buf: Buffer;
  try {
    const st = statSync(abs);
    if (st.size > MAX_FILE_BYTES) return { ok: false, error: "too-large" };
    buf = readFileSync(abs);
  } catch {
    return { ok: false, error: "missing" };
  }
  if (buf.subarray(0, 8000).includes(0)) return { ok: false, error: "binary" };
  return { ok: true, content: buf.toString("utf8") };
}
