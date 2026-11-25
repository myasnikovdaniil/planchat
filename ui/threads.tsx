// Thread list items, comments, reactions and the composer.

import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, type Me, type ReactionDef, type ThreadView, type Author, type LineDiff } from "./api.ts";
import {
  IconChevron,
  IconDiff,
  IconBot,
  IconCheck,
  IconCrosshair,
  IconDots,
  IconEye,
  IconHand,
  IconHelp,
  IconThumb,
  IconMessage,
  IconPencil,
  IconPlay,
  IconRotate,
  IconSmilePlus,
  IconTrash,
  IconUnlink,
} from "./icons.tsx";

type Comment = ThreadView["comments"][number];
type Change = NonNullable<Comment["change"]>;
export type Intent = "do" | "explain" | null;

const MENTION_SPLIT = /((?:^|[\s([{,;:"'«])@[A-Za-z0-9][A-Za-z0-9._-]{0,63})/g;

export function ago(ts: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

const same = (a: Author, b: Author) => a.kind === b.kind && a.name === b.name;

function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function Avatar({ author, size = 24 }: { author: Author; size?: number }) {
  const style = { width: `${size}px`, height: `${size}px`, ...(author.kind === "human" ? { "--h": String(hue(author.name)) } : {}) };
  return (
    <span class={`avatar by-${author.kind}`} style={style as any} title={`${author.kind}: ${author.name}`}>
      {author.kind === "session" ? <IconBot size={Math.round(size * 0.6)} /> : author.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Body({ text, clamp }: { text: string; clamp?: boolean }) {
  const parts = text.split(MENTION_SPLIT);
  return (
    <div class={`body ${clamp ? "clamp" : ""}`}>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <>
            {p.slice(0, p.indexOf("@"))}
            <span class="mention">{p.slice(p.indexOf("@"))}</span>
          </>
        ) : (
          p
        ),
      )}
    </div>
  );
}

// ------------------------------------------------------------------ input

export function MentionInput(props: {
  value: string;
  onInput: (v: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  sessions: string[];
  placeholder?: string;
  autoFocus?: boolean;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ items: string[]; index: number; from: number } | null>(null);

  useEffect(() => {
    if (props.autoFocus) setTimeout(() => ref.current?.focus(), 0);
  }, []);

  const resize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  };

  const update = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    const m = /(^|[\s([{,;:"'«])@([A-Za-z0-9._-]*)$/.exec(before);
    if (!m) return setMenu(null);
    const items = props.sessions.filter((s) => s.toLowerCase().startsWith(m[2].toLowerCase()));
    setMenu(items.length ? { items, index: 0, from: before.length - m[2].length - 1 } : null);
  };

  const choose = (name: string) => {
    const el = ref.current!;
    const caret = el.selectionStart ?? el.value.length;
    const from = menu!.from;
    const v = el.value.slice(0, from) + "@" + name + " " + el.value.slice(caret);
    props.onInput(v);
    setMenu(null);
    requestAnimationFrame(() => {
      const pos = from + name.length + 2;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (menu) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setMenu({ ...menu, index: (menu.index + d + menu.items.length) % menu.items.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(menu.items[menu.index]);
        return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenu(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      props.onSubmit();
    } else if (e.key === "Escape" && props.onCancel) {
      e.stopPropagation();
      props.onCancel();
    }
  };

  return (
    <div class="mention-input">
      <textarea
        ref={ref}
        value={props.value}
        placeholder={props.placeholder}
        rows={props.rows ?? 2}
        onInput={(e) => {
          const el = e.currentTarget;
          props.onInput(el.value);
          update(el);
          resize(el);
        }}
        onKeyDown={onKeyDown as any}
        onBlur={() => setTimeout(() => setMenu(null), 150)}
      />
      {menu && (
        <ul class="mention-menu">
          {menu.items.map((s, i) => (
            <li class={i === menu.index ? "sel" : ""} onMouseDown={(e) => (e.preventDefault(), choose(s))}>
              <IconBot size={13} /> {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function audienceOf(body: string, current: ThreadView["audience"] | null): string {
  const names = [...body.matchAll(/(?:^|[\s([{,;:"'«])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g)].map((m) => m[1].replace(/[.\-_]+$/, ""));
  if (names.length) return names.map((n) => "@" + n).join(" ");
  if (current && current !== "*") return current.map((n) => "@" + n).join(" ");
  return "every subscribed session";
}

/** Comment box with optional intent (do / explain) chips. */
export function Composer(props: {
  sessions: string[];
  placeholder: string;
  submitLabel: string;
  intent?: Intent;
  showIntents?: boolean;
  audience?: ThreadView["audience"] | null;
  autoFocus?: boolean;
  onSubmit: (body: string, intent: Intent) => Promise<void>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState("");
  const [intent, setIntent] = useState<Intent>(props.intent ?? null);
  const [busy, setBusy] = useState(false);
  const submit = () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    props
      .onSubmit(body, intent)
      .then(() => {
        setBody("");
        setIntent(null);
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return (
    <div class="composer">
      <MentionInput value={body} onInput={setBody} onSubmit={submit} onCancel={props.onCancel} sessions={props.sessions} placeholder={props.placeholder} autoFocus={props.autoFocus} rows={2} />
      <div class="composer-foot">
        {props.showIntents !== false && (
          <div class="intents" role="radiogroup" aria-label="what should the agent do">
            <button class={`chip ${intent === null ? "on" : ""}`} onClick={() => setIntent(null)} title="just a comment: the agent answers, changes nothing">
              <IconMessage size={13} /> Comment
            </button>
            <button class={`chip do ${intent === "do" ? "on" : ""}`} onClick={() => setIntent(intent === "do" ? null : "do")} title="the agent makes the change">
              <IconPlay size={12} /> Do it
            </button>
            <button class={`chip explain ${intent === "explain" ? "on" : ""}`} onClick={() => setIntent(intent === "explain" ? null : "explain")} title="the agent explains, changes nothing">
              <IconHelp size={13} /> Explain
            </button>
          </div>
        )}
        <span class="to" title="who receives this">
          to {audienceOf(body, props.audience ?? null)}
        </span>
        <div class="actions">
          {props.onCancel && (
            <button class="btn ghost" onClick={props.onCancel}>
              Cancel
            </button>
          )}
          <button class="btn primary" onClick={submit} disabled={!body.trim() || busy} title="Ctrl+Enter">
            {props.submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- reactions

/** Icon for the built-in kinds; custom kinds keep their configured emoji. */
export function ReactionIcon({ d, size = 13 }: { d: ReactionDef; size?: number }) {
  switch (d.kind) {
    case "do":
      return <IconPlay size={size - 2} />;
    case "explain":
      return <IconHelp size={size} />;
    case "hold":
      return <IconHand size={size} />;
    case "discuss":
      return <IconDots size={size} />;
    case "ack":
      return <IconThumb size={size} />;
    case "seen":
      return <IconEye size={size} />;
    default:
      return <span>{d.emoji ?? "•"}</span>;
  }
}

const PALETTE_W = 300;
const PALETTE_H = 270;

/** Where to put a popup next to a button so it stays inside the window. */
function popupPosition(btn: HTMLElement): Record<string, string> {
  const r = btn.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - PALETTE_W - 8));
  if (r.bottom + 6 + PALETTE_H > window.innerHeight - 8 && r.top - 6 - PALETTE_H > 8) {
    return { left: `${left}px`, bottom: `${window.innerHeight - r.top + 6}px` };
  }
  return { left: `${left}px`, top: `${r.bottom + 6}px` };
}

function ReactionBar(props: { target: string; reactions: Comment["reactions"]; me: Me; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState<Record<string, string> | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e.type === "mousedown" && ref.current?.contains(e.target as Node)) return;
      setOpen(null);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const byKind = new Map<string, Author[]>();
  for (const r of props.reactions) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.author]);
  const toggle = (d: ReactionDef) => {
    const mine = (byKind.get(d.kind) ?? []).some((a) => same(a, props.me.author));
    api.react(props.target, d.kind, !mine).catch(props.onError);
    setOpen(null);
  };
  const defs = props.me.reactions;
  const used = defs.filter((d) => byKind.has(d.kind));
  return (
    <div class="reaction-bar" ref={ref}>
      {used.map((d) => {
        const who = byKind.get(d.kind)!;
        const mine = who.some((a) => same(a, props.me.author));
        return (
          <button class={`pill ${d.type} k-${d.kind} ${mine ? "mine" : ""}`} onClick={() => toggle(d)} title={`${d.kind}: ${d.hint}\n${who.map((a) => a.name).join(", ")}`}>
            <span class="emoji">
              <ReactionIcon d={d} />
            </span>
            <span>{d.kind}</span>
            {who.length > 1 && <span class="count">{who.length}</span>}
          </button>
        );
      })}
      <button ref={addRef} class="pill add" onClick={() => setOpen(open ? null : popupPosition(addRef.current!))} title="react">
        <IconSmilePlus size={14} />
      </button>
      {open && (
        <div class="palette" style={open}>
          {(["trigger", "signal"] as const).map((type) => (
            <div class="palette-group">
              <div class="palette-title">{type === "trigger" ? "Wakes the agent" : "Marks for the agent"}</div>
              {defs
                .filter((d) => d.type === type)
                .map((d) => {
                  const mine = (byKind.get(d.kind) ?? []).some((a) => same(a, props.me.author));
                  return (
                    <button class={`palette-item ${d.type} ${mine ? "mine" : ""}`} onClick={() => toggle(d)}>
                      <span class="emoji">
                        <ReactionIcon d={d} size={14} />
                      </span>
                      <span class="kind">{d.kind}</span>
                      <span class="hint">{d.hint}</span>
                      {mine && <IconCheck size={14} />}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- change

function Stats({ stats }: { stats: Change["stats"] }) {
  if (stats === null) return <span class="muted">old version no longer kept</span>;
  if (!stats) return null;
  return (
    <span class="stats">
      <span class="add">+{stats.added}</span>
      <span class="del">−{stats.removed}</span>
    </span>
  );
}

function DiffBody({ diff }: { diff: LineDiff }) {
  return (
    <div class="diff">
      {diff.hunks.map((h) => (
        <div class="hunk">
          <div class="hunk-head">
            @@ −{h.oldStart} +{h.newStart} @@
          </div>
          {h.lines.map((l) => (
            <div class={`dl ${l.t === "+" ? "add" : l.t === "-" ? "del" : ""}`}>
              <span class="ln">{l.old ?? ""}</span>
              <span class="ln">{l.new ?? ""}</span>
              <span class="sign">{l.t === " " ? "" : l.t === "-" ? "−" : "+"}</span>
              <span class="code">{l.s || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** "Changed <file> +a −r", expanding to the line diff. */
export function ChangeRow(props: { ws: string; change: Change; label?: string }) {
  const { change } = props;
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<LineDiff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !diff && !err) {
      api
        .diff(props.ws, change.from, change.to)
        .then(setDiff)
        .catch((e) => setErr(errorText(e)));
    }
  };
  return (
    <div class={`change ${open ? "open" : ""}`}>
      <button class="change-head" onClick={toggle} disabled={change.stats === null} title="what changed in the file">
        <IconDiff size={13} />
        <span>
          {props.label ?? "Changed"} <code>{change.file}</code>
        </span>
        <Stats stats={change.stats} />
        <span class="grow" />
        {change.stats !== null && (
          <span class={`caret ${open ? "open" : ""}`}>
            <IconChevron size={13} />
          </span>
        )}
      </button>
      {open && (err ? <div class="diff-note">{err}</div> : diff ? diff.hunks.length ? <DiffBody diff={diff} /> : <div class="diff-note">no line changes</div> : <div class="diff-note">loading…</div>)}
    </div>
  );
}

// ---------------------------------------------------------------- comment

function CommentRow(props: { c: Comment; root: boolean; ws: string; me: Me; sessions: string[]; onError: (e: unknown) => void }) {
  const { c, me } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const mine = same(c.author, me.author);
  const save = () =>
    api
      .editComment(c.id, draft)
      .then(() => setEditing(false))
      .catch(props.onError);
  return (
    <div class={`comment by-${c.author.kind}`}>
      <Avatar author={c.author} size={26} />
      <div class="comment-main">
        <div class="comment-head">
          <span class="who">{c.author.name}</span>
          {c.author.kind === "session" && <span class="tag">agent</span>}
          <span class="when" title={c.ts}>
            {ago(c.ts)}
            {c.edited ? " · edited" : ""}
          </span>
          {mine && !c.deleted && !editing && (
            <span class="own">
              <button class="icon-btn" title="edit" onClick={() => (setDraft(c.body), setEditing(true))}>
                <IconPencil size={13} />
              </button>
              {!props.root && (
                <button class="icon-btn" title="delete" onClick={() => confirm("Delete this comment?") && api.deleteComment(c.id).catch(props.onError)}>
                  <IconTrash size={13} />
                </button>
              )}
            </span>
          )}
        </div>
        {c.deleted ? (
          <div class="body deleted">comment deleted</div>
        ) : editing ? (
          <div class="edit-box">
            <MentionInput value={draft} onInput={setDraft} onSubmit={save} onCancel={() => setEditing(false)} sessions={props.sessions} autoFocus />
            <div class="actions">
              <button class="btn ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button class="btn primary" onClick={save}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <Body text={c.body} />
        )}
        {c.change && <ChangeRow ws={props.ws} change={c.change} />}
        {!c.deleted && <ReactionBar target={c.id} reactions={c.reactions} me={me} onError={props.onError} />}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- thread

function hasReaction(t: ThreadView, kind: string, who?: Author): boolean {
  return t.comments.some((c) => c.reactions.some((r) => r.kind === kind && (!who || same(r.author, who))));
}

export function ThreadItem(props: {
  t: ThreadView;
  me: Me;
  sessions: string[];
  online: Set<string>;
  active: boolean;
  itemRef?: (el: HTMLElement | null) => void;
  onSelect: () => void;
  onClose: () => void;
  onLocate?: () => void;
  onReanchor?: () => void;
  onError: (e: unknown) => void;
}) {
  const { t, me } = props;
  const root = t.comments[0];
  const replies = t.comments.length - 1;
  const quote = t.anchor.state === "orphaned" ? t.quote : t.anchor.exact;
  const kinds = new Map<string, number>();
  for (const c of t.comments) for (const r of c.reactions) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
  const defs = me.reactions;
  const intentOn = (k: string) => hasReaction(t, k, me.author);
  const changes = [...t.comments.map((c) => c.change), t.resolved?.change].filter((c): c is Change => !!c && !!c.stats);
  const total = changes.length ? changes.reduce((a, c) => ({ added: a.added + c.stats!.added, removed: a.removed + c.stats!.removed }), { added: 0, removed: 0 }) : null;

  const toggleIntent = (k: "do" | "explain") => api.react(t.id, k, !root.reactions.some((r) => r.kind === k && same(r.author, me.author))).catch(props.onError);

  return (
    <article
      ref={props.itemRef}
      class={`thread ${props.active ? "active" : ""} ${t.status} anchor-${t.anchor.state}`}
      onClick={(e) => {
        if (!props.active && !(e.target as HTMLElement).closest("button, textarea, a, .palette")) props.onSelect();
      }}
    >
      <header class="thread-top" onClick={(e) => props.active && !(e.target as HTMLElement).closest("button") && props.onClose()}>
        <Avatar author={root.author} size={22} />
        <span class="who">{root.author.name}</span>
        <span class="when">{ago(root.ts)}</span>
        <span class="grow" />
        {hasReaction(t, "do") && (
          <span class="intent do">
            <IconPlay size={10} /> do
          </span>
        )}
        {hasReaction(t, "explain") && (
          <span class="intent explain">
            <IconHelp size={11} /> explain
          </span>
        )}
        {t.status === "resolved" && (
          <span class="state resolved">
            <IconCheck size={12} /> resolved
          </span>
        )}
        {t.lines && <span class="lines">L{t.lines.from === t.lines.to ? t.lines.from : `${t.lines.from}–${t.lines.to}`}</span>}
      </header>

      <div class="quote" title={quote}>
        <span class="quote-text">{quote}</span>
        {t.anchor.state !== "ok" && (
          <span class={`anchor-state ${t.anchor.state}`} title={t.anchor.reason ?? ""}>
            {t.anchor.state === "orphaned" ? <IconUnlink size={11} /> : null}
            {t.anchor.state}
          </span>
        )}
      </div>

      {!props.active ? (
        <>
          <Body text={root.body} clamp />
          <footer class="thread-meta">
            {replies > 0 && (
              <span>
                <IconMessage size={12} /> {replies} {replies === 1 ? "reply" : "replies"}
              </span>
            )}
            {total && (
              <span class="stats" title="lines the agents changed in this thread">
                <IconDiff size={12} />
                <span class="add">+{total.added}</span>
                <span class="del">−{total.removed}</span>
              </span>
            )}
            {t.claim && (
              <span class={`claim ${t.claimStale ? "stale" : props.online.has(t.claim.session) ? "live" : ""}`}>
                <IconBot size={12} /> {t.claim.session}
                {t.claimStale ? " · stale" : ""}
              </span>
            )}
            {[...kinds].filter(([k]) => k !== "do" && k !== "explain").map(([k, n]) => {
              const d = defs.find((x) => x.kind === k) ?? { kind: k, type: "signal" as const, hint: "" };
              return (
                <span class="mini-reaction" title={k}>
                  <ReactionIcon d={d} size={12} />
                  {n > 1 ? ` ${n}` : ""}
                </span>
              );
            })}
            <span class="grow" />
            <span class="audience">{t.audience === "*" ? "all sessions" : t.audience.map((a) => "@" + a).join(" ")}</span>
          </footer>
        </>
      ) : (
        <div class="thread-body">
          <div class="thread-bar">
            <button class={`chip do ${intentOn("do") ? "on" : ""}`} onClick={() => toggleIntent("do")} title="ask the agent to make the change">
              <IconPlay size={12} /> Do it
            </button>
            <button class={`chip explain ${intentOn("explain") ? "on" : ""}`} onClick={() => toggleIntent("explain")} title="ask the agent to explain, without changes">
              <IconHelp size={13} /> Explain
            </button>
            <span class="grow" />
            <span class="audience" title="who hears about this thread">
              {t.audience === "*" ? "all sessions" : t.audience.map((a) => "@" + a).join(" ")}
            </span>
          </div>
          {t.claim && (
            <div class={`claim-row ${t.claimStale ? "stale" : ""}`}>
              <IconBot size={14} />
              <span>
                <b>{t.claim.session}</b> is on it{t.claimStale ? " — offline, claim is stale" : props.online.has(t.claim.session) ? "" : " — offline"}
              </span>
              <span class="grow" />
              {me.author.kind === "human" && (
                <button class="btn ghost small" onClick={() => api.release(t.id).catch(props.onError)} title="take the claim away; the thread goes to the audience again">
                  Release
                </button>
              )}
            </div>
          )}
          <div class="comments">
            {t.comments.map((c, i) => (
              <CommentRow c={c} root={i === 0} ws={t.ws} me={me} sessions={props.sessions} onError={props.onError} />
            ))}
            {t.resolved && (
              <div class="resolved-row">
                <span class="resolved-icon">
                  <IconCheck size={13} />
                </span>
                <div class="comment-main">
                  <div class="comment-head">
                    <span class="who">{t.resolved.by.name}</span>
                    <span class="muted small">resolved the thread</span>
                    <span class="when" title={t.resolved.ts}>
                      {ago(t.resolved.ts)}
                    </span>
                  </div>
                  {t.resolved.change && <ChangeRow ws={t.ws} change={t.resolved.change} />}
                </div>
              </div>
            )}
          </div>
          <Composer
            sessions={props.sessions}
            placeholder="Reply… @session to address it"
            submitLabel="Reply"
            showIntents={false}
            audience={t.audience}
            onSubmit={async (body, intent) => {
              try {
                const v = await api.reply(t.id, body);
                const added = v.comments[v.comments.length - 1];
                if (intent && added) await api.react(added.id, intent, true);
              } catch (e) {
                props.onError(e);
                throw e;
              }
            }}
          />
          <div class="thread-actions">
            {props.onLocate && t.anchor.state !== "orphaned" && (
              <button class="btn ghost small" onClick={props.onLocate}>
                <IconCrosshair size={13} /> Show in file
              </button>
            )}
            {props.onReanchor && t.anchor.state !== "ok" && t.anchor.state !== "moved" && (
              <button class="btn ghost small" onClick={props.onReanchor} title="select new text in the file, then press “Move here”">
                <IconUnlink size={13} /> Re-anchor
              </button>
            )}
            <span class="grow" />
            {t.status === "open" ? (
              <button class="btn small" onClick={() => api.resolve(t.id).catch(props.onError)}>
                <IconCheck size={13} /> Resolve
              </button>
            ) : (
              <button class="btn small" onClick={() => api.reopen(t.id).catch(props.onError)}>
                <IconRotate size={13} /> Reopen
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
