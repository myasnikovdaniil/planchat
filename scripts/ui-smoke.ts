// UI smoke test in headless Chromium: selection -> comment in source and
// rendered mode, reactions, live reply, re-anchoring after an edit.
//   bun run scripts/ui-smoke.ts [--shots DIR]
// Needs a Chromium; set CHROMIUM=/path/to/chrome or have Playwright's
// headless shell in ~/.cache/ms-playwright.

import { chromium, type Page } from "playwright-core";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { PlanchatServer } from "../src/server.ts";

function findChromium(): string {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = join(homedir(), ".cache", "ms-playwright");
  for (const d of readdirSync(base)) {
    if (d.startsWith("chromium_headless_shell-")) return join(base, d, "chrome-linux", "headless_shell");
    if (d.startsWith("chromium-")) return join(base, d, "chrome-linux", "chrome");
  }
  throw new Error("no Chromium found; set CHROMIUM");
}

const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const root = mkdtempSync(join(tmpdir(), "planchat-ui-"));
mkdirSync(join(root, "docs"));
mkdirSync(join(root, "src"));
writeFileSync(
  join(root, "docs", "plan.md"),
  "# Plan\n\nWe use `alpha beta` here, plus **bold** and a &amp; b.\n\n- first item\n- second item\n\n```ts\nconst x = 1;\n```\n",
);
writeFileSync(join(root, "src", "app.ts"), "export function one() {\r\n  return 1;\r\n}\r\n\r\nexport function two() {\r\n  return 2;\r\n}\r\n");

const server = new PlanchatServer(
  { ...defaultConfig(), port: 0, defaultAuthor: "alice", workspaces: [{ name: "w", root, include: ["**"], exclude: [] }], debounceMs: 50 },
  { port: 0, lan: null, auth: false, persist: false, quiet: true },
);
await server.start();
const url = `http://127.0.0.1:${server.port}`;
const hub = server.hub;
hub.subscribe("a", "w", ["**"]);

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Drag-select the n-th occurrence of `text` inside `scope` with the real mouse. */
async function dragSelect(page: Page, scope: string, text: string) {
  const box = await page.evaluate(
    ({ scope, text }) => {
      // the text may span several text nodes (syntax highlighting splits tokens)
      const rootEl = document.querySelector(scope)!;
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
      const nodes: { n: Text; at: number }[] = [];
      let joined = "";
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push({ n: n as Text, at: joined.length });
        joined += n.textContent;
      }
      const i = joined.indexOf(text);
      if (i < 0) return null;
      const locate = (off: number, end: boolean) => {
        for (let k = nodes.length - 1; k >= 0; k--) {
          const { n, at } = nodes[k];
          if (end ? off > at : off >= at) return { n, o: off - at };
        }
        return { n: nodes[0].n, o: 0 };
      };
      const s = locate(i, false);
      const e = locate(i + text.length, true);
      const r = document.createRange();
      r.setStart(s.n, s.o);
      r.setEnd(e.n, e.o);
      const rects = r.getClientRects();
      const first = rects[0];
      const last = rects[rects.length - 1];
      return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
    },
    { scope, text },
  );
  if (!box) throw new Error(`text ${text} not found in ${scope}`);
  await page.mouse.move(box.x1, box.y1);
  await page.mouse.down();
  await page.mouse.move(box.x2, box.y2, { steps: 5 });
  await page.mouse.up();
}

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

try {
  // --- source mode, CRLF file
  await page.goto(`${url}/#ws=w&file=src/app.ts`);
  await page.waitForSelector(".cm-content");
  await dragSelect(page, ".cm-content", "return 2;");
  await page.click(".sel-toolbar .tb >> text=Comment");
  await page.fill(".popover textarea", "@a why two?");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(".panel .thread");
  let threads = [...hub.ws("w").state.threads.values()];
  check("source-mode selection on a CRLF file maps to raw offsets", threads[0]?.anchor.exact === "return 2;", JSON.stringify(threads[0]?.anchor.exact));
  check("@a in the root comment narrows the audience", JSON.stringify(threads[0]?.audience) === '["a"]');
  const hl = await page.$$eval(".planchat-hl", (els) => els.map((e) => e.textContent).join("|"));
  check("highlight shown on the anchored text", hl.includes("return 2;"), hl);
  if (shots) await page.screenshot({ path: join(shots, "1-source.png") });

  // --- reaction from the palette on the root comment
  await page.click(".thread.active .comment .pill.add");
  await page.click(".thread.active .palette .palette-item >> text=do");
  await page.waitForFunction(() => document.querySelector(".thread .pill.k-do.mine") !== null);
  threads = [...hub.ws("w").state.threads.values()];
  check("reaction `do` stored", threads[0].comments[0].reactions.some((r) => r.kind === "do" && r.author.name === "alice"));

  // --- live reply from a session shows up without reload
  const t0 = Date.now();
  hub.ws("w").reply({ kind: "session", name: "a" }, threads[0].id, "because the spec says so");
  await page.waitForSelector("text=because the spec says so", { timeout: 3000 });
  const dt = Date.now() - t0;
  check("session reply visible in the UI under 1 s", dt < 1000, `${dt} ms`);

  // --- file edit moves the highlight, scroll kept
  writeFileSync(join(root, "src", "app.ts"), "// header\r\n// more\r\nexport function one() {\r\n  return 1;\r\n}\r\n\r\nexport function two() {\r\n  return 2;\r\n}\r\n");
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("// header"), null, { timeout: 4000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".planchat-hl")].some((e) => e.textContent === "return 2;"), null, { timeout: 4000 });
  threads = [...hub.ws("w").state.threads.values()];
  check("anchor moved after the edit", threads[0].anchor.state === "moved" && threads[0].anchor.exact === "return 2;", threads[0].anchor.state);

  // --- rendered markdown: select inside inline code
  await page.goto(`${url}/#ws=w&file=docs/plan.md&mode=rendered`);
  await page.waitForSelector(".markdown-body code");
  await dragSelect(page, ".markdown-body", "beta");
  await page.click(".sel-toolbar .tb.do");
  await page.fill(".popover textarea", "rename beta");
  await page.click(".popover .btn.primary");
  await page.waitForFunction(() => document.querySelectorAll(".panel .thread").length === 1);
  const md = [...hub.ws("w").state.threads.values()].find((t) => t.file === "docs/plan.md");
  check("rendered selection inside `alpha beta` maps to exactly `beta`", md?.anchor.exact === "beta", JSON.stringify(md?.anchor.exact));
  check("“Do” in the selection toolbar sets the do reaction on the new thread", !!md?.comments[0].reactions.some((r) => r.kind === "do"));

  await dragSelect(page, ".markdown-body", "a & b");
  await page.waitForSelector(".sel-toolbar");
  await page.keyboard.press("c");
  await page.fill(".popover textarea", "entity");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.querySelectorAll(".panel .thread").length === 2);
  const ent = [...hub.ws("w").state.threads.values()].find((t) => t.comments[0].body === "entity");
  check("rendered selection over an entity maps to the source reference", ent?.anchor.exact === "a &amp; b", JSON.stringify(ent?.anchor.exact));
  if (shots) await page.screenshot({ path: join(shots, "2-rendered.png") });

  // --- orphan: delete the anchored text
  writeFileSync(join(root, "docs", "plan.md"), "# Plan\n\nWe use `alpha` here, plus **bold**.\n");
  await page.waitForSelector(".group-title", { timeout: 4000 });
  check("deleted anchor shows up in the “Text gone” group", (await page.textContent(".group"))!.includes("orphaned"));
  if (shots) await page.screenshot({ path: join(shots, "3-orphan.png") });

  // --- re-anchor the orphan on a new selection
  await page.click(".group .thread >> nth=0");
  await page.click(".group .thread.active button:has-text('Re-anchor')");
  await dragSelect(page, ".markdown-body", "alpha");
  await page.click(".sel-toolbar .tb.primary");
  await page.waitForFunction(() => document.querySelectorAll(".group .thread").length === 1, null, { timeout: 4000 });
  const moved = [...hub.ws("w").state.threads.values()].find((t) => t.file === "docs/plan.md" && t.anchor.state === "ok");
  check("orphan re-anchored on a new selection", moved?.anchor.exact === "alpha", JSON.stringify(moved?.anchor.exact));

  // --- the agent claims, edits the file and replies: the reply shows the diff
  {
    const w = hub.ws("w");
    const t = [...w.state.threads.values()].find((x) => x.file === "src/app.ts")!;
    w.claim({ kind: "session", name: "a" }, t.id);
    writeFileSync(join(root, "src", "app.ts"), "// header\r\n// more\r\nexport function one() {\r\n  return 1;\r\n}\r\n\r\nexport function two() {\r\n  return 2 + 0;\r\n}\r\n");
    w.reply({ kind: "session", name: "a" }, t.id, "made it explicit");
    await page.goto(`${url}/#ws=w&file=src/app.ts&t=${t.id}`);
    await page.waitForSelector(".thread.active .change-head");
    const head = await page.textContent(".thread.active .change-head");
    check("agent reply shows what it changed", !!head && head.includes("src/app.ts") && head.includes("+1") && head.includes("−1"), head ?? "");
    await page.click(".thread.active .change-head");
    await page.waitForSelector(".thread.active .diff .dl.add");
    const added = await page.$$eval(".thread.active .diff .dl.add .code", (els) => els.map((e) => e.textContent));
    const removed = await page.$$eval(".thread.active .diff .dl.del .code", (els) => els.map((e) => e.textContent));
    check("diff shows the removed and added line", JSON.stringify(removed) === JSON.stringify(["  return 2;"]) && JSON.stringify(added) === JSON.stringify(["  return 2 + 0;"]), JSON.stringify({ removed, added }));
    if (shots) await page.screenshot({ path: join(shots, "5-diff.png") });
  }

  // --- narrow window: the reaction palette on an agent comment stays on screen
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${url}/#ws=w&file=src/app.ts`);
  await page.waitForSelector(".panel .thread");
  await page.click(".panel .thread >> nth=0");
  await page.waitForSelector(".thread.active .comment.by-session");
  await page.click(".thread.active .comment.by-session .pill.add");
  const pal = await page.$eval(".thread.active .comment.by-session .palette", (el) => el.getBoundingClientRect().toJSON());
  check("reaction palette on an agent comment fits the window at 1280 px", pal.left >= 0 && pal.right <= 1280, JSON.stringify(pal));
  await page.click(".thread.active .comment.by-session .palette .palette-item >> text=ack");
  await page.waitForFunction(() => document.querySelector(".thread.active .comment.by-session .pill.mine") !== null);
  check("reaction on an agent comment stored", [...hub.ws("w").state.threads.values()].some((t) => t.comments.some((c) => c.author.kind === "session" && c.reactions.some((r) => r.kind === "ack"))));
  if (shots) await page.screenshot({ path: join(shots, "4-narrow.png") });

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  failures++;
  console.error(e);
  if (shots) await page.screenshot({ path: join(shots, "error.png") });
} finally {
  await browser.close();
  server.stop();
}
console.log(failures ? `${failures} failure(s)` : "all ok");
process.exit(failures ? 1 : 0);
