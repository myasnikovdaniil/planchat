// ~/.config/planchat/config.json (or $PLANCHAT_HOME/config.json) and the CLI token file.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./store.ts";

export type ReactionType = "trigger" | "signal";

export interface ReactionDef {
  kind: string;
  type: ReactionType;
  /** what it means for the agent; shown in the UI tooltip and in instructions */
  hint: string;
  emoji?: string;
}

export interface WorkspaceConfig {
  name: string;
  root: string;
  include: string[];
  exclude: string[];
}

export interface Config {
  port: number;
  /** extra listen address (LAN / tailnet), loopback is always on */
  lan: string | null;
  defaultAuthor: string;
  /** token name -> sha256(token) */
  tokens: Record<string, string>;
  workspaces: WorkspaceConfig[];
  reactions: ReactionDef[];
  snapshots: number;
  graceSeconds: number;
  quoteThreshold: number;
  debounceMs: number;
  /** extra Host header values accepted besides loopback and the LAN address */
  allowedHosts: string[];
  /** the codex binary the daemon runs to deliver events into Codex sessions */
  codexBin: string;
}

export const DEFAULT_REACTIONS: ReactionDef[] = [
  { kind: "do", type: "trigger", hint: "do what the thread asks", emoji: "▶" },
  { kind: "explain", type: "trigger", hint: "answer in the thread, do not change files", emoji: "?" },
  { kind: "hold", type: "signal", hint: "do not touch this part", emoji: "✋" },
  { kind: "discuss", type: "signal", hint: "question is open, no decision yet", emoji: "…" },
  { kind: "ack", type: "signal", hint: "agreed / accepted", emoji: "👍" },
  { kind: "seen", type: "signal", hint: "set by the agent that took the thread", emoji: "👀" },
];

export const DEFAULT_EXCLUDE = ["**/node_modules/**", "**/.git/**", "**/.planchat/**"];

export function planchatHome(): string {
  return process.env.PLANCHAT_HOME ?? join(homedir(), ".config", "planchat");
}

export function configPath(): string {
  return join(planchatHome(), "config.json");
}

export function tokenPath(): string {
  return join(planchatHome(), "token");
}

function defaultAuthor(): string {
  try {
    return userInfo().username;
  } catch {
    return "human";
  }
}

export function defaultConfig(): Config {
  return {
    port: 7717,
    lan: null,
    defaultAuthor: defaultAuthor(),
    tokens: {},
    workspaces: [],
    reactions: DEFAULT_REACTIONS,
    snapshots: 20,
    graceSeconds: 120,
    quoteThreshold: 0.75,
    debounceMs: 150,
    allowedHosts: [],
    codexBin: "codex",
  };
}

export function normalizeWorkspace(w: Partial<WorkspaceConfig> & { name: string; root: string }): WorkspaceConfig {
  return {
    name: w.name,
    root: resolve(w.root),
    include: w.include?.length ? w.include : ["**"],
    exclude: w.exclude ?? [],
  };
}

export function loadConfig(path = configPath()): Config {
  const base = defaultConfig();
  if (!existsSync(path)) return base;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  const cfg: Config = { ...base, ...raw };
  cfg.workspaces = (raw.workspaces ?? []).map(normalizeWorkspace);
  cfg.reactions = raw.reactions?.length ? raw.reactions : DEFAULT_REACTIONS;
  cfg.tokens = raw.tokens ?? {};
  return cfg;
}

export function saveConfig(cfg: Config, path = configPath()): void {
  mkdirSync(planchatHome(), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, JSON.stringify(cfg, null, 2) + "\n");
  chmodSync(path, 0o600);
}

export function configMtime(path = configPath()): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function readToken(): string | null {
  if (process.env.PLANCHAT_TOKEN) return process.env.PLANCHAT_TOKEN;
  try {
    return readFileSync(tokenPath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const WORKSPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
