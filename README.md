# planchat

Comment threads on character ranges of files, delivered live to coding agents that are already running: Claude Code, Codex CLI, or any agent with a shell or MCP.

- A human selects text in the browser UI (source view for any file, rendered view for markdown) and leaves a comment. The anchor is a range of the raw file, not a line.
- Threads have an audience: everyone subscribed to the file, or the sessions named with `@name`.
- Reactions are intents. Triggers (`do`, `explain`) wake the audience; signals (`hold`, `discuss`, `ack`, `seen`) are read along with the thread.
- A session takes a thread with `claim` before working on it; a second session gets `claimed_by` and leaves it alone.
- Anchors follow edits of the file (diff against a snapshot); text that is gone becomes an orphaned thread instead of a comment on the wrong place.
- Every agent reply (and resolve) carries what the agent changed in the thread's file since it took the thread or since the previous comment: `+N −M` in the thread, a line diff on click.
- A link can narrow the UI to the files one session is discussing, so several reviews run side by side on one daemon.

One daemon serves the whole machine. A **workspace** is a directory it exposes; a **session** is a named agent session subscribed to some files of some workspaces. A human comment reaches the sessions subscribed to that file.

## Install

Requires [Bun](https://bun.sh) 1.2+ to build (the repo pins it as a dev dependency).

```bash
npm install            # or: bun install
npm run build          # UI bundle + single binary dist/planchat
install -m 755 dist/planchat ~/.local/bin/planchat
```

## First run

```bash
planchat token add "$USER" --save      # prints a token once; --save writes ~/.config/planchat/token for the CLI
planchat ws add docs ~/src/my-project  # a workspace: a directory exposed in the UI
planchat serve                         # 127.0.0.1:7717; prints the listen addresses
```

Then get the link to the UI with `planchat url` (see [Opening the UI](#opening-the-ui)).

Add `.planchat/` to the project's `.gitignore` (or to your global git ignore): the daemon keeps its event log, snapshots and delivery cursors there.

The UI lists every file of a workspace that its `.gitignore` files do not ignore. planchat reads only `.gitignore` files inside the workspace, not `.git/info/exclude` or a global ignore file, so exclude what must not show up, for example secrets committed to the repository and worktree directories:

```bash
planchat ws add infra ~/src/infra --exclude '**/.worktrees/**' --exclude '**/kubeconfig' --exclude '**/*.key' --exclude '**/.env'
```

### systemd user unit

```ini
# ~/.config/systemd/user/planchat.service
[Unit]
Description=planchat daemon

[Service]
# the daemon runs `codex queue` to deliver into Codex sessions
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.local/bin/planchat serve
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now planchat
```

## Opening the UI

```bash
planchat url docs/plan.md
```

```
local   http://127.0.0.1:7717/?token=…#ws=docs&file=docs%2Fplan.md
lan     http://192.168.1.20:7717/?token=…#ws=docs&file=docs%2Fplan.md
```

`planchat url [FILE]` asks the running daemon for its port, LAN address and auth mode, and puts the token from `~/.config/planchat/token` into the link. The `lan` line appears only when the daemon listens on a LAN address. Opening a `?token=` link once moves the token into an HttpOnly cookie for that address and cleans the URL; after that the same link without `?token=` works too. `--no-token` leaves the token out, `--mode source|rendered` picks the view, `--json` prints both links as fields.

Agents should always take the link from `planchat url`. The config file holds a sha256 of each token, and a link built from it is refused.

### Listening on a LAN or tailnet

```bash
planchat serve --lan 100.101.102.103       # loopback stays on; the extra address needs the same tokens
```

Or set `lan` in the config. Each person gets their own token (`planchat token add alice`); the name is the author of their comments. Add a Host name other than the IP to `allowedHosts` in the config if you reach the daemon through one.

## Reviewing a few files

Subscribe the session to the files under discussion, with paths relative to the workspace root, and open the link with that session:

```bash
planchat --session plan-review subscribe docs docs/plan.md docs/rollout.md
planchat --session plan-review url docs/plan.md
```

A link with `session=<name>` lists only the files that session is subscribed to. The list follows the subscription live. A link without a file opens the first file of the list. "all files" next to the session name goes back to the whole workspace, and clicking a session in the sidebar narrows the list to it.

Several sessions can review different files at the same time: each subscribes to its own files and the user keeps one tab per session. They all share one daemon. Do not start a second `planchat serve` on the same workspaces: each workspace keeps its log in `<root>/.planchat`, and two daemons would write the same files.

Inside an agent shell that is already connected (`planchat events`, `planchat mcp` or `planchat attach codex`), `planchat url` narrows the link to that session without `--session`.

## Agents

| agent | how events arrive | how the agent acts |
|---|---|---|
| Claude Code, any running session | `planchat events` under the Monitor tool (skill `planchat-watch`), re-armed every 30 min | CLI through Bash |
| Claude Code started with channels | `planchat mcp --channel` pushes `<channel>` messages | MCP tools |
| Codex CLI (checked on 0.166) | `planchat attach codex` once; the daemon runs `codex queue` for every event (skill `planchat-codex`) | CLI through the shell |
| any other agent with a shell or MCP | nothing pushes: poll `planchat list --since`, or use the `planchat mcp` tools | CLI or MCP tools |

### Claude Code: already running session, Monitor (no flags needed)

Install the skill and ask the session to watch planchat:

```bash
mkdir -p ~/.claude/skills && cp -r skills/planchat-watch ~/.claude/skills/
```

The skill picks a session name, subscribes it to the files the user named (or to the whole workspace of the current directory), arms a Monitor on `planchat events --session <name>` (30 minutes, re-armed on every expiry), gives the user the link from `planchat url`, and handles each event through claim → work → reply → resolve. The session runs the CLI through Bash, always with `--session <name>`.

Events are one line each:

```
[planchat] alice commented on docs/plan.md:42–44 «quoted text» (ws=docs, thread=01J…, event=01J…, reactions: do) user-text: the comment
```

### Claude Code: session started with channels, MCP shim

```json
{
  "mcpServers": {
    "planchat": { "command": "planchat", "args": ["mcp", "--session", "b", "--channel"] }
  }
}
```

```bash
claude --mcp-config planchat-mcp.json --dangerously-load-development-channels server:planchat
```

The shim offers the same operations as MCP tools and pushes each event as a `<channel source="planchat" …>` message, which wakes an idle session. Without `--channel` the shim only offers the tools. Do not run `planchat events` and `planchat mcp --channel` under the same session name.

### Codex CLI

```bash
mkdir -p ~/.codex/skills && cp -r skills/planchat-codex ~/.codex/skills/
```

Ask the session to attach to planchat, or run in it:

```bash
planchat attach codex --session cx
```

The thread id comes from `CODEX_THREAD_ID`, which Codex sets for every command it runs. From then on the daemon delivers each event with `codex queue --thread <id> --message <text>`: an idle Codex TUI starts a turn on its own, a busy one takes the message after the current turn, and a closed session gets it when resumed. Several events waiting at once go out as one message. Nothing has to keep running inside the Codex sandbox, which could not write to `~/.codex` anyway. The attachment survives daemon restarts (`$PLANCHAT_HOME/attachments.json`); `planchat detach` ends it.

After attaching, `planchat` commands from that Codex session act as the attached session without `--session`. The daemon needs `codex` in its `PATH`, or `codexBin` in the config.

If your Codex setup asks for approval on commands that reach outside the workspace, allow the `planchat` prefix once, or every claim and reply will stop for a prompt.

### Other agents

Any agent that can run a command uses the CLI with `--session <name>` and polls `planchat list --since <seq>` for new threads. An agent with MCP support runs `planchat mcp --session <name>` as a stdio server and gets the same operations as tools.

## CLI

```
planchat serve [--port N] [--lan ADDR] [--no-auth [--no-auth-lan]]
planchat ws add NAME PATH [--include GLOB]... [--exclude GLOB]... | planchat ws list
planchat token add NAME [--save]
planchat url [FILE] [--ws W] [--mode source|rendered] [--no-token]
planchat events [--session NAME] [--cwd DIR]
planchat mcp [--session NAME] [--channel]
planchat attach codex [--session NAME] [--thread ID] | planchat detach [--session NAME]
planchat sessions | subscribe [WS] [GLOB]... | unsubscribe [WS]
planchat list [--ws W] [--file F] [--status open|resolved|all] [--since SEQ|ISO]
planchat get THREAD
planchat reply THREAD BODY|-
planchat create FILE BODY|- (--exact TEXT [--nth N] | --start N --end N [--base-hash H])
planchat react TARGET KIND [--off]
planchat claim | release | resolve | reopen THREAD
```

Global flags: `--session NAME` (or `PLANCHAT_SESSION`), `--human`, `--url URL` (or `PLANCHAT_URL`), `--json`.

`subscribe` replaces the session's file list for that workspace.

Offsets in `--start/--end` are UTF-16 code units of the raw file (CRLF counts as two).

## Configuration

`~/.config/planchat/config.json` (`$PLANCHAT_HOME/config.json`), written with defaults on the first `planchat serve`:

| key | default | meaning |
|---|---|---|
| `port` | 7717 | listen port |
| `lan` | null | extra listen address |
| `defaultAuthor` | `$USER` | human name in `--no-auth` mode |
| `tokens` | {} | name → sha256 of the token |
| `workspaces` | [] | `{name, root, include: ["**"], exclude: []}`; `.gitignore` files inside the root are honoured |
| `reactions` | do, explain, hold, discuss, ack, seen | `{kind, type: trigger\|signal, hint, emoji}` |
| `snapshots` | 20 | file versions kept per file for re-anchoring |
| `graceSeconds` | 120 | after this long offline, a session's claims show as stale |
| `quoteThreshold` | 0.75 | context similarity needed to find a quote without a snapshot |
| `debounceMs` | 150 | file watcher debounce |
| `allowedHosts` | [] | extra `Host` header values (DNS rebinding guard) |
| `codexBin` | `codex` | binary the daemon runs for `codex queue` |

The daemon reads `tokens` again when the file changes, and `planchat ws add` against a running daemon adds the workspace at once. Other edits to the file take a restart.

## Security

- Every request needs a token: a bearer header from the CLI, or the cookie a `?token=` link sets in the browser. The cookie is HttpOnly and SameSite=Strict. `Host` must be a listen address (or in `allowedHosts`), and a browser request that changes something must come from the same origin.
- Workspaces are added only from the machine itself (a request from 127.0.0.1 or ::1), with or without a token: whoever reaches the LAN address cannot expose another directory.
- One directory is the root of at most one workspace. A second one on the same root is refused, and a duplicate in the config is skipped at startup with an error in the log.
- Inside a Claude Code or Codex shell, a command that changes something and has no `--session` is refused unless that agent session is connected (`planchat events`/`planchat mcp` for Claude, `planchat attach codex` for Codex): the daemon maps `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID` to the session name. A human typing in such a shell passes `--human`. This keeps an agent from posting as a human and waking other sessions.
- `--no-auth` listens on 127.0.0.1 only. `--no-auth --no-auth-lan --lan ADDR` drops the token on the LAN address too and prints a warning: anyone on that network reads every workspace and posts comments, and comments reach agent sessions that have shell access. Prefer a token per person.

## Delivery rules

A session receives an event when it is subscribed to the file and is in the thread's audience, for:

- a new thread or comment by a human;
- a trigger reaction by a human;
- a release of an open thread: by a human, to the whole audience; by its owner, to the rest of the audience minus sessions that already answered the latest human input (two sessions that reply and release never bounce a thread between each other).

Never: the session's own actions, other sessions' actions, signal reactions, resolved threads. A claimed thread reaches only its owner. A human comment that mentions sessions outside the current audience replaces the audience.

Delivery is at-least-once: the daemon keeps a cursor per session and resends everything after it on the next connection (Monitor re-arm, daemon restart). Every line carries `event=<id>`; sessions skip ids they already handled.

## Development

```bash
bun test                          # unit + integration (daemon, WS, CLI processes)
bun run scripts/ui-smoke.ts       # headless Chromium: selection → comment in both modes, live updates, session scope
npx tsc --noEmit -p .
```

`ui-smoke.ts` uses Playwright's headless shell from `~/.cache/ms-playwright`, or the browser in `CHROMIUM`.

Layout: `src/anchor.ts` (re-anchoring), `src/offsets.ts` (raw↔CodeMirror, rendered markdown → source), `src/store.ts` (event log, recovery, snapshots), `src/router.ts` (audience, claim, delivery), `src/server.ts` (HTTP, SSE, WS, auth), `src/watch.ts`, `src/client.ts`, `src/mcp.ts`, `src/cli.ts`, `ui/` (Preact + CodeMirror 6 + unified), `src/codex.ts` (delivery into Codex), `skills/planchat-watch/`, `skills/planchat-codex/`. Phase 0 findings: `docs/phase0.md`.

Not in scope: editing files in the UI, suggestions, git integration, one store across hosts.
