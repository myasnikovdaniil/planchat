# Phase 0: how a running Claude Code session hears about events

Checked on Claude Code 2.1.332 with a claude.ai login, before the rest of the code was written.

## Monitor with a `command` source (session without flags)

- A Monitor running a script that prints a line every 10 s delivers each line as a notification while the session is busy (between tool calls).
- At `timeout_ms` the Monitor is killed and one expiry notice arrives with the event count. Re-arming with the same command works; the new process starts from scratch.
- Consequence for planchat: the event stream must survive the re-arm gap, hence per-session cursors and at-least-once delivery in the daemon. `planchat events` acknowledges an event only after the line is flushed to stdout.

## Channels (session started with `--dangerously-load-development-channels server:<name>`)

From the [channels docs](https://code.claude.com/docs/en/channels) and a live session with `spike/channel-server.ts`:

- The server declares `capabilities.experimental["claude/channel"] = {}`.
- Notification: `{"method": "notifications/claude/channel", "params": {"content": string, "meta"?: Record<string, string>}}`. Meta keys must match `^[a-zA-Z_][a-zA-Z0-9_]*$`; others are dropped with a warning.
- In the session it shows up as `<channel source="<server>" key="value" …>content</channel>`. An idle session wakes up and starts a turn for every notification.
- Tools of the same server are available in that session.
- The debug log (`--debug-file`) says `Channel notifications registered` for the server. Org policy did not block it on a personal account; team and enterprise accounts need `channelsEnabled: true` in managed settings.
- The shim uses `@modelcontextprotocol/sdk` 1.32.2 (protocol up to `2025-11-25`). Re-check channel delivery after bumping the SDK to a newer protocol revision.
- A server entry for `--channels` / `--dangerously-load-development-channels` must be tagged: `server:<name>` for a configured MCP server, `plugin:<name>@<marketplace>` for a plugin. Dev channels show a confirmation dialog at startup.
- A small model (Haiku) ignored the server `instructions` and only acknowledged the raw events; it followed them once the user prompt said what to do. The shim's instructions are explicit, and the event line itself names the action ("reacted "do" on …").

## Decision

Both paths are kept:

1. **Primary**: CLI `planchat` through Bash plus Monitor `command: planchat events --session <name>`. Works in any running session, no flags.
2. **Additional**: `planchat mcp --session <name> --channel` for sessions started with the channel flag. Without `--channel` the shim only offers the tools and does not hold the event stream, so a session that cannot receive channel notifications never swallows events.
