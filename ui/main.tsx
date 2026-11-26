import { render } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiError, stream, type FileContent, type FileList, type Me, type SessionInfo, type ThreadView } from "./api.ts";
import type { DocView, Selection } from "./doc-view.ts";
import { SourceView } from "./source-view.ts";
import { RenderedView } from "./rendered-view.ts";
import { Avatar, Composer, errorText, ThreadItem, type Intent } from "./threads.tsx";
import {
  IconBot,
  IconChevron,
  IconFile,
  IconFileCode,
  IconFileText,
  IconFolder,
  IconHelp,
  IconMessage,
  IconMoon,
  IconPanelRight,
  IconPlay,
  IconSidebar,
  IconSun,
  IconUnlink,
} from "./icons.tsx";

type Mode = "source" | "rendered";
type Filter = "open" | "resolved" | "all";

// session: list only the files that session is subscribed to
function readHash(): { ws?: string; file?: string; mode?: Mode; t?: string; session?: string } {
  const p = new URLSearchParams(location.hash.slice(1));
  return {
    ws: p.get("ws") ?? undefined,
    file: p.get("file") ?? undefined,
    mode: (p.get("mode") as Mode) ?? undefined,
    t: p.get("t") ?? undefined,
    session: p.get("session") || undefined,
  };
}

function writeHash(s: { ws?: string; file?: string; mode?: Mode; t?: string | null; session?: string }) {
  const p = new URLSearchParams();
  if (s.ws) p.set("ws", s.ws);
  if (s.file) p.set("file", s.file);
  if (s.mode) p.set("mode", s.mode);
  if (s.t) p.set("t", s.t);
  if (s.session) p.set("session", s.session);
  const next = "#" + p.toString();
  if (location.hash !== next) history.replaceState(null, "", next);
}

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

function fileIcon(name: string) {
  if (/\.(md|markdown|mdx|txt|rst)$/i.test(name)) return <IconFileText size={15} />;
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cc|cpp|h|hpp|sh|rb|kt|swift|sql|css|html|vue|svelte|json|ya?ml|toml)$/i.test(name)) return <IconFileCode size={15} />;
  return <IconFile size={15} />;
}

// ------------------------------------------------------------------ tree

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file: boolean;
}

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), file: false };
  for (const f of files) {
    let n = root;
    const parts = f.split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let c = n.children.get(part);
      if (!c) {
        c = { name: part, path, children: new Map(), file: i === parts.length - 1 };
        n.children.set(part, c);
      }
      n = c;
    });
  }
  return root;
}

function Tree(props: { node: TreeNode; current?: string; counts: FileList["threads"]; open: Set<string>; toggle: (p: string) => void; pick: (p: string) => void; depth?: number }) {
  const depth = props.depth ?? 0;
  const kids = [...props.node.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
  return (
    <ul class="tree">
      {kids.map((k) => {
        const pad = { paddingLeft: `${depth * 14 + 10}px` };
        if (k.file) {
          const c = props.counts[k.path];
          return (
            <li>
              <button class={`row file ${k.path === props.current ? "current" : ""}`} style={pad} onClick={() => props.pick(k.path)} title={k.path}>
                <span class="ico">{fileIcon(k.name)}</span>
                <span class="name">{k.name}</span>
                {c && c.open > 0 && <span class="badge">{c.open}</span>}
              </button>
            </li>
          );
        }
        const isOpen = props.open.has(k.path);
        const inside = Object.entries(props.counts).reduce((n, [p, c]) => (p.startsWith(k.path + "/") ? n + c.open : n), 0);
        return (
          <li>
            <button class="row dir" style={pad} onClick={() => props.toggle(k.path)}>
              <span class={`caret ${isOpen ? "open" : ""}`}>
                <IconChevron size={13} />
              </span>
              <span class="ico">
                <IconFolder size={15} />
              </span>
              <span class="name">{k.name}</span>
              {!isOpen && inside > 0 && <span class="badge dim">{inside}</span>}
            </button>
            {isOpen && <Tree {...props} node={k} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- canvas

interface CanvasProps {
  ws: string;
  file: FileContent;
  mode: Mode;
  setMode: (m: Mode) => void;
  markdown: boolean;
  threads: ThreadView[];
  sessions: string[];
  active: string | null;
  setActive: (id: string | null) => void;
  reanchor: string | null;
  setReanchor: (id: string | null) => void;
  reload: () => void;
  toast: (msg: string) => void;
  registerLocate: (fn: (t: ThreadView) => void) => void;
}

function Canvas(p: CanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<DocView | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [composing, setComposing] = useState<{ sel: Selection; intent: Intent } | null>(null);
  const [, bump] = useState(0);

  const locate = useCallback((t: ThreadView) => {
    const v = viewRef.current;
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!v || !canvas || !host) return;
    const y = v.anchorTop(t);
    if (y === null) return;
    const hostTop = host.getBoundingClientRect().top - canvas.getBoundingClientRect().top + canvas.scrollTop;
    canvas.scrollTo({ top: Math.max(0, hostTop + y - canvas.clientHeight / 3), behavior: "smooth" });
  }, []);

  useEffect(() => p.registerLocate(locate), [locate]);

  useEffect(() => {
    const host = hostRef.current!;
    const cb = {
      onSelect: (s: Selection | null) => {
        setSel(s);
      },
      onActivate: (ids: string[]) => {
        if (ids.length) p.setActive(ids[0]);
      },
      onLayout: () => bump((n) => n + 1),
      onUnmappable: () => p.toast("This selection touches rendered text that has no place in the source. Switch to Source to comment on it."),
    };
    const v = p.mode === "rendered" ? new RenderedView(host, p.file.content, cb) : new SourceView(host, p.file.path, p.file.content, cb);
    viewRef.current = v;
    v.setThreads(p.threads, p.active);
    return () => {
      v.destroy();
      viewRef.current = null;
      setSel(null);
      setComposing(null);
    };
  }, [p.file.path, p.mode, p.ws]);

  useLayoutEffect(() => {
    const v = viewRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    const top = c.scrollTop;
    v.setContent(p.file.content);
    c.scrollTop = top;
  }, [p.file.hash]);

  useEffect(() => {
    viewRef.current?.setThreads(p.threads, p.active);
  }, [p.threads, p.active]);

  // keyboard: c = comment on the selection, Esc = close. State goes through a
  // ref so the handler is never one render behind what is on screen.
  const keyState = useRef({ sel, composing, reanchor: p.reanchor, setReanchor: p.setReanchor });
  keyState.current = { sel, composing, reanchor: p.reanchor, setReanchor: p.setReanchor };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keyState.current;
      const typing = e.target instanceof Element && e.target.closest("textarea, input, select");
      if (e.key === "Escape") {
        if (k.composing) setComposing(null);
        else if (k.sel) {
          viewRef.current?.clearSelection();
          setSel(null);
        } else if (k.reanchor) k.setReanchor(null);
      } else if (!typing && k.sel && !k.composing && !k.reanchor && (e.key === "c" || e.key === "C") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setComposing({ sel: k.sel, intent: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const place = (s: Selection, below: boolean, width: number) => {
    const inner = innerRef.current?.getBoundingClientRect();
    if (!inner) return { left: 0, top: 0 };
    const maxLeft = Math.max(8, inner.width - width - 8);
    const left = Math.min(Math.max(8, s.rect.left - inner.left), maxLeft);
    const top = below ? s.rect.bottom - inner.top + 10 : s.rect.top - inner.top - 46;
    return { left, top: top < 4 ? s.rect.bottom - inner.top + 10 : top };
  };

  const create = async (body: string, intent: Intent) => {
    if (!composing) return;
    const s = composing.sel;
    try {
      const t = await api.create(p.ws, p.file.path, { start: s.start, end: s.end, baseHash: p.file.hash }, body);
      if (intent) await api.react(t.id, intent, true);
      setComposing(null);
      setSel(null);
      viewRef.current?.clearSelection();
      p.setActive(t.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        p.toast("The file changed under your selection. Select the text again.");
        setComposing(null);
        p.reload();
      } else p.toast(errorText(e));
      throw e;
    }
  };

  const moveHere = async () => {
    if (!sel || !p.reanchor) return;
    try {
      await api.moveAnchor(p.reanchor, { start: sel.start, end: sel.end, baseHash: p.file.hash });
      p.setActive(p.reanchor);
      p.setReanchor(null);
      viewRef.current?.clearSelection();
      setSel(null);
    } catch (e) {
      p.toast(errorText(e));
      if (e instanceof ApiError && e.status === 409) p.reload();
    }
  };

  const toolbar = sel && !composing ? place(sel, false, 300) : null;
  const pop = composing ? place(composing.sel, true, 460) : null;
  const parts = p.file.path.split("/");

  return (
    <main class="canvas" ref={canvasRef} onScroll={() => sel && bump((n) => n + 1)}>
      <div class="canvas-inner" ref={innerRef}>
        <div class={`doc-card ${p.mode}`}>
          <div class="doc-head">
            <div class="crumbs">
              {parts.map((x, i) => (
                <span class={i === parts.length - 1 ? "leaf" : ""}>
                  {x}
                  {i < parts.length - 1 && <span class="sep">/</span>}
                </span>
              ))}
            </div>
            {p.markdown && (
              <div class="seg">
                <button class={p.mode === "rendered" ? "on" : ""} onClick={() => p.setMode("rendered")}>
                  Rendered
                </button>
                <button class={p.mode === "source" ? "on" : ""} onClick={() => p.setMode("source")}>
                  Source
                </button>
              </div>
            )}
          </div>
          <div class={`doc-host mode-${p.mode}`} ref={hostRef} />
        </div>

        {toolbar && sel && (
          <div class="sel-toolbar" style={{ left: `${toolbar.left}px`, top: `${toolbar.top}px` }} onMouseDown={(e) => e.preventDefault()}>
            {p.reanchor ? (
              <button class="tb primary" onClick={moveHere}>
                <IconUnlink size={14} /> Move thread here
              </button>
            ) : (
              <>
                <button class="tb" onClick={() => setComposing({ sel, intent: null })} title="Comment (C)">
                  <IconMessage size={14} /> Comment <kbd>C</kbd>
                </button>
                <span class="tb-sep" />
                <button class="tb do" onClick={() => setComposing({ sel, intent: "do" })} title="ask the agent to change this">
                  <IconPlay size={12} /> Do
                </button>
                <button class="tb explain" onClick={() => setComposing({ sel, intent: "explain" })} title="ask the agent to explain this">
                  <IconHelp size={14} /> Explain
                </button>
              </>
            )}
          </div>
        )}

        {composing && pop && (
          <div class="popover" style={{ left: `${pop.left}px`, top: `${pop.top}px` }}>
            <div class="popover-quote" title={composing.sel.text}>
              {composing.sel.text}
            </div>
            <Composer
              sessions={p.sessions}
              placeholder="What about it? @session narrows who hears it"
              submitLabel="Comment"
              intent={composing.intent}
              autoFocus
              onSubmit={create}
              onCancel={() => setComposing(null)}
            />
          </div>
        )}
      </div>
    </main>
  );
}

// ----------------------------------------------------------------- panel

function Panel(props: {
  threads: ThreadView[];
  all: number;
  filter: Filter;
  setFilter: (f: Filter) => void;
  counts: { open: number; resolved: number };
  me: Me;
  sessions: string[];
  online: Set<string>;
  active: string | null;
  setActive: (id: string | null) => void;
  locate: (t: ThreadView) => void;
  setReanchor: (id: string | null) => void;
  toast: (m: string) => void;
  hasFile: boolean;
}) {
  const refs = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    if (!props.active) return;
    refs.current.get(props.active)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [props.active]);
  const orphans = props.threads.filter((t) => t.anchor.state === "orphaned");
  const placed = props.threads.filter((t) => t.anchor.state !== "orphaned").sort((a, b) => a.anchor.start - b.anchor.start || a.created.localeCompare(b.created));
  const item = (t: ThreadView) => (
    <ThreadItem
      key={t.id}
      t={t}
      me={props.me}
      sessions={props.sessions}
      online={props.online}
      active={t.id === props.active}
      itemRef={(el) => (el ? refs.current.set(t.id, el) : refs.current.delete(t.id))}
      onSelect={() => {
        props.setActive(t.id);
        props.locate(t);
      }}
      onClose={() => props.setActive(null)}
      onLocate={() => props.locate(t)}
      onReanchor={props.me.author.kind === "human" ? () => (props.setReanchor(t.id), props.toast("Select the new text in the file, then press “Move thread here”.")) : undefined}
      onError={(e) => props.toast(errorText(e))}
    />
  );
  return (
    <aside class="panel">
      <div class="panel-head">
        <span class="title">Threads</span>
        <div class="seg small">
          {(["open", "resolved", "all"] as Filter[]).map((f) => (
            <button class={props.filter === f ? "on" : ""} onClick={() => props.setFilter(f)}>
              {f === "open" ? `Open ${props.counts.open}` : f === "resolved" ? `Resolved ${props.counts.resolved}` : "All"}
            </button>
          ))}
        </div>
      </div>
      <div class="panel-list">
        {!props.hasFile && <div class="empty-note">Pick a file to see its threads.</div>}
        {props.hasFile && props.threads.length === 0 && (
          <div class="empty-note">
            <IconMessage size={28} />
            <div>{props.all === 0 ? "No threads yet" : "Nothing here"}</div>
            <small>Select text in the document to start a thread.</small>
          </div>
        )}
        {orphans.length > 0 && (
          <div class="group">
            <div class="group-title">
              <IconUnlink size={12} /> Text gone · {orphans.length}
            </div>
            {orphans.map(item)}
          </div>
        )}
        {placed.map(item)}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------- app

function App() {
  const initial = readHash();
  const [me, setMe] = useState<Me | null>(null);
  const [ws, setWs] = useState<string | undefined>(initial.ws);
  const [files, setFiles] = useState<FileList | null>(null);
  const [path, setPath] = useState<string | undefined>(initial.file);
  const [file, setFile] = useState<FileContent | null>(null);
  const [mode, setMode] = useState<Mode>(initial.mode ?? "rendered");
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [active, setActive] = useState<string | null>(initial.t ?? null);
  const [scope, setScope] = useState<string | undefined>(initial.session);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [reanchor, setReanchor] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const [theme, setTheme] = useState<string>(store.get("planchat-theme") ?? "dark");
  const wide = typeof window !== "undefined" && window.innerWidth > 980;
  const [sidebar, setSidebar] = useState(store.get("planchat-sidebar") === null ? wide : store.get("planchat-sidebar") !== "0");
  const [panel, setPanel] = useState(store.get("planchat-panel") === null ? wide : store.get("planchat-panel") !== "0");
  const locateRef = useRef<(t: ThreadView) => void>(() => {});

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    store.set("planchat-theme", theme);
  }, [theme]);
  useEffect(() => store.set("planchat-sidebar", sidebar ? "1" : "0"), [sidebar]);
  useEffect(() => store.set("planchat-panel", panel ? "1" : "0"), [panel]);

  const toast = useCallback((msg: string) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m);
        if (!ws || !m.workspaces.some((w) => w.name === ws)) setWs(m.workspaces[0]?.name);
      })
      .catch((e) => toast(errorText(e)));
  }, []);

  const loadFiles = useCallback(
    () =>
      ws &&
      api
        .files(ws, scopeRef.current)
        // a slow answer for a scope the user already left must not overwrite the current list
        .then((f) => f.scope?.session === scopeRef.current && setFiles(f))
        .catch((e) => toast(errorText(e))),
    [ws],
  );
  const loadThreads = useCallback(() => ws && api.threads(ws).then(setThreads).catch((e) => toast(errorText(e))), [ws]);
  const loadSessions = useCallback(() => api.sessions().then(setSessions).catch(() => {}), []);
  const pathRef = useRef(path);
  pathRef.current = path;
  const loadFile = useCallback(() => {
    const p = pathRef.current;
    if (!ws || !p) return;
    api
      .file(ws, p)
      .then((f) => {
        if (f.path === pathRef.current) setFile((old) => (old && old.path === f.path && old.hash === f.hash ? old : f));
      })
      .catch((e) => {
        toast(errorText(e));
        setFile(null);
      });
  }, [ws]);

  useEffect(() => {
    if (!ws) return;
    loadFiles();
    loadThreads();
    loadSessions();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = (fn: () => void) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, 40);
    };
    const close = stream(
      ws,
      (m) => {
        if (m.type === "event") soon(() => (loadThreads(), loadFiles()));
        else if (m.type === "file" && m.path === pathRef.current) loadFile();
        else if (m.type === "tree") loadFiles();
        else if (m.type === "sessions") {
          loadSessions();
          // a subscription change moves files in or out of the scoped list
          if (scopeRef.current) loadFiles();
        }
      },
      () => {
        loadThreads();
        loadFiles();
        loadSessions();
        loadFile();
      },
    );
    const tick = setInterval(() => (loadThreads(), loadSessions()), 30_000);
    return () => {
      close();
      clearInterval(tick);
    };
  }, [ws]);

  useEffect(() => {
    setFile(null);
    loadFile();
    if (path) {
      const parts = path.split("/");
      setOpenDirs((s) => {
        const n = new Set(s);
        for (let i = 1; i < parts.length; i++) n.add(parts.slice(0, i).join("/"));
        return n;
      });
    }
  }, [path, ws]);

  useEffect(() => writeHash({ ws, file: path, mode, t: active, session: scope }), [ws, path, mode, active, scope]);

  useEffect(() => {
    if (!ws) return;
    setFiles(null);
    loadFiles();
  }, [scope]);

  // a scoped link without a file opens the first file of the scope
  useEffect(() => {
    if (scope && !path && files?.scope?.session === scope && files.files.length > 0) setPath(files.files[0]);
  }, [files, scope]);

  useEffect(() => {
    const onHash = () => {
      const h = readHash();
      if (h.ws) setWs(h.ws);
      setPath(h.file);
      if (h.mode) setMode(h.mode);
      setActive(h.t ?? null);
      setScope(h.session);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const tree = useMemo(() => buildTree(files?.files ?? []), [files]);
  const onFile = useMemo(() => threads.filter((t) => t.file === path), [threads, path]);
  const counts = { open: onFile.filter((t) => t.status === "open").length, resolved: onFile.filter((t) => t.status === "resolved").length };
  const listed = onFile.filter((t) => filter === "all" || t.status === filter);
  // highlights: whatever the list shows, plus the active thread
  const highlighted = onFile.filter((t) => t.anchor.state !== "orphaned" && (filter === "all" || t.status === filter || t.id === active));
  const sessionNames = sessions.map((s) => s.name);
  const online = new Set(sessions.filter((s) => s.online).map((s) => s.name));
  const wsSessions = sessions.filter((s) => s.subscriptions.some((x) => x.ws === ws));
  const md = path ? isMarkdown(path) : false;
  const effectiveMode: Mode = md ? mode : "source";

  if (!me) return <div class="splash">planchat</div>;
  if (me.workspaces.length === 0) {
    return (
      <div class="splash">
        <h1>planchat</h1>
        <p>
          No workspaces yet. Add one: <code>planchat ws add &lt;name&gt; &lt;path&gt;</code>
        </p>
      </div>
    );
  }

  return (
    <div class={`app ${sidebar ? "" : "no-sidebar"} ${panel ? "" : "no-panel"}`}>
      <header class="topbar">
        <button class="icon-btn" onClick={() => setSidebar(!sidebar)} title="toggle files">
          <IconSidebar size={17} />
        </button>
        <span class="brand">
          <span class="mark" />
          planchat
        </span>
        <select class="ws-select" value={ws} onChange={(e) => (setWs(e.currentTarget.value), setPath(undefined), setActive(null))}>
          {me.workspaces.map((w) => (
            <option value={w.name}>{w.name}</option>
          ))}
        </select>
        <span class="grow" />
        <span class="online-pill" title={wsSessions.map((s) => `${s.online ? "●" : "○"} ${s.name}`).join("\n") || "no sessions"}>
          <span class={`dot ${wsSessions.some((s) => s.online) ? "on" : ""}`} />
          {wsSessions.filter((s) => s.online).length}/{wsSessions.length} sessions
        </span>
        <button class="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="theme">
          {theme === "dark" ? <IconSun size={17} /> : <IconMoon size={17} />}
        </button>
        <span class="me">
          <Avatar author={me.author} size={24} />
          {me.author.name}
        </span>
        <button class={`icon-btn ${panel ? "" : "dim"}`} onClick={() => setPanel(!panel)} title="toggle threads">
          <IconPanelRight size={17} />
          {!panel && counts.open > 0 && <span class="dot-count">{counts.open}</span>}
        </button>
      </header>

      <aside class="sidebar">
        <div class="side-title">
          Files
          {scope && (
            <span class="scope-chip" title={`only the files ${scope} is subscribed to: ${files?.scope?.globs.join(", ") ?? ""}`}>
              <IconBot size={12} />
              {scope}
              <button class="scope-clear" onClick={() => setScope(undefined)} title="show all files">
                all files
              </button>
            </span>
          )}
        </div>
        <div class="side-scroll">
          {scope && files?.scope?.session === scope && files.files.length === 0 && (
            <div class="muted small scope-empty">
              {scope} is subscribed to no file in {ws}.{" "}
              <button class="btn ghost small" onClick={() => setScope(undefined)}>
                Show all files
              </button>
            </div>
          )}
          <Tree
            node={tree}
            current={path}
            counts={files?.threads ?? {}}
            open={openDirs}
            toggle={(d) =>
              setOpenDirs((s) => {
                const n = new Set(s);
                n.has(d) ? n.delete(d) : n.add(d);
                return n;
              })
            }
            pick={(f) => (setPath(f), setActive(null), setReanchor(null))}
          />
        </div>
        <div class="side-title">Sessions</div>
        <div class="sessions">
          {wsSessions.length === 0 && (
            <div class="muted small">No session subscribed. Connect an agent: the planchat-watch skill in Claude Code, planchat attach codex in Codex.</div>
          )}
          {wsSessions.map((s) => (
            <button
              class={`session-row ${s.online ? "online" : ""} ${s.name === scope ? "scoped" : ""}`}
              onClick={() => setScope(s.name === scope ? undefined : s.name)}
              title={`${s.subscriptions.map((x) => `${x.ws}: ${x.globs.join(", ")}`).join("\n")}\n\n${s.name === scope ? "click: show all files" : "click: show only this session's files"}`}
            >
              <span class="status" />
              <IconBot size={14} />
              <span class="name">{s.name}</span>
              <span class="via">{s.online ? s.transport ?? "" : "offline"}</span>
            </button>
          ))}
        </div>
      </aside>

      {reanchor && (
        <div class="banner">
          <IconUnlink size={14} /> Re-anchoring: select the new text and press “Move thread here”.
          <button class="btn ghost small" onClick={() => setReanchor(null)}>
            Cancel
          </button>
        </div>
      )}

      {ws && file && file.path === path ? (
        <Canvas
          ws={ws}
          file={file}
          mode={effectiveMode}
          setMode={setMode}
          markdown={md}
          threads={highlighted}
          sessions={sessionNames}
          active={active}
          setActive={setActive}
          reanchor={reanchor}
          setReanchor={setReanchor}
          reload={loadFile}
          toast={toast}
          registerLocate={(fn) => (locateRef.current = fn)}
        />
      ) : (
        <main class="canvas">
          <div class="canvas-empty">{path ? "Loading…" : "Pick a file on the left."}</div>
        </main>
      )}

      <Panel
        threads={listed}
        all={onFile.length}
        filter={filter}
        setFilter={setFilter}
        counts={counts}
        me={me}
        sessions={sessionNames}
        online={online}
        active={active}
        setActive={setActive}
        locate={(t) => locateRef.current(t)}
        setReanchor={setReanchor}
        toast={toast}
        hasFile={!!path}
      />

      <div class="toasts">
        {toasts.map((t) => (
          <div class="toast">{t.msg}</div>
        ))}
      </div>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
