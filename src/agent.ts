// Which coding agent a CLI call comes from, read from the environment the
// agent sets for the commands it runs.

import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { sha256 } from "./store.ts";

/** "claude:<session id>" inside Claude Code, "codex:<thread id>" inside Codex, else undefined. */
export function agentFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.CLAUDE_CODE_SESSION_ID) return `claude:${env.CLAUDE_CODE_SESSION_ID}`;
  if (env.CODEX_THREAD_ID) return `codex:${env.CODEX_THREAD_ID}`;
  return undefined;
}

export const AGENT_RE = /^(claude|codex):[A-Za-z0-9._-]{1,128}$/;

/** `<cwd basename>-<4 hex>`; the hex comes from the agent id when there is one, so it is stable for that agent session. */
export function defaultSessionName(agent = agentFromEnv(), cwd = process.cwd()): { name: string; stable: boolean } {
  const base = basename(cwd).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "session";
  const hex = agent ? sha256(agent.slice(agent.indexOf(":") + 1)).slice(0, 4) : randomBytes(2).toString("hex");
  return { name: `${base.slice(0, 58)}-${hex}`, stable: !!agent };
}
