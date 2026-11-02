#!/usr/bin/env node
// UI e2e for the FlowRad Viewer renderer with REAL mouse and keyboard input
// (Playwright, Chromium), on a synthetic CT with two series:
//
//   border     the active viewport has a 3 px accent outline; clicking another moves it
//   dnd        dragging a series card onto a viewport shows it there (ghost + drop hint)
//   keys       ↑/↓ slice, ←/→ series, PgUp/PgDn 10 %, Home/End, Shift+digit layouts, ? sheet
//   remap      Settings → change a shortcut → the new key works, the old one doesn't
//   cursors    each tool has its own cursor on the image; the UI keeps the arrow
//   annotate   arrow with no prompt; inline label; select + Delete; undo / redo;
//              right-click menu (delete, delete all on image / series); eraser
//
//   node desktop/scripts/e2e-ui.mjs <study-dir> [--only border,keys] [--shots <dir>]
//
// Needs the renderer build (npm --prefix desktop run build). Exit 1 on any failure.

import { createServer } from "node:http";
import { readFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
const study = args.find((a) => !a.startsWith("--"));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = flag("only")?.split(",");
const shots = flag("shots");
// Voice: a WAV of spoken commands for Chromium's fake microphone (CI makes it
// with espeak-ng); --require-voice fails instead of skipping without a model.
const voiceWav = flag("voice-wav");
const requireVoice = args.includes("--require-voice");
if (!study) {
  console.error("usage: e2e-ui.mjs <study-dir> [--only a,b] [--shots dir]");
  process.exit(2);
}

const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "dist");
if (!existsSync(dist)) throw new Error("Build the renderer first: npm --prefix desktop run build");

async function listFiles(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const p = path.join(dir, name);
    if ((await stat(p)).isDirectory()) out.push(...(await listFiles(p)));
    else out.push(p);
  }
  return out;
}

const types = { ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".html": "text/html", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const file = path.join(dist, url.pathname === "/" ? "index.html" : url.pathname);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const { chromium } = createRequire(import.meta.url)("playwright");
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: [
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    ...(voiceWav ? [`--use-file-for-fake-audio-capture=${path.resolve(voiceWav)}`] : []),
  ],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write", "microphone"] });
// Voice must load nothing until the mic is switched on.
const voiceRequests = [];
context.on("request", (r) => /\/assets\/vosk-|\/voice\/model/.test(r.url()) && voiceRequests.push(r.url()));
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("response", (r) => r.status() >= 400 && !/favicon/.test(r.url()) && consoleErrors.push(`${r.status()} ${r.url()}`));
// The arrow tool must never open a browser prompt.
let dialogs = 0;
page.on("dialog", async (d) => {
  dialogs += 1;
  await d.dismiss();
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.error(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
async function shot(name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}
const settle = (ms = 250) => page.waitForTimeout(ms);
const want = (group) => !only || only.includes(group);

// ── open the study ──────────────────────────────────────────────────────
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForSelector("text=Open a study");
await page.locator('input[type="file"]').first().setInputFiles(await listFiles(study));
await page.waitForSelector('[data-has-series="1"]', { timeout: 60_000 });
// The engine paints after the preview; wait for the "Im n / N" overlay.
await page.waitForFunction(() => /Im \d+ \/ \d+/.test(document.body.innerText), null, { timeout: 60_000 });
await settle(800);

const cell = (i) => page.locator(`[data-drop-cell="${i}"]`);
const imageNo = async (i = 0) => {
  const text = await cell(i).innerText();
  const m = text.match(/Im (\d+) \/ (\d+)/);
  return m ? { at: Number(m[1]), of: Number(m[2]) } : null;
};
// Series identity on screen: description line plus image count ("Im n / N").
const seriesText = async (i = 0) => {
  const text = await cell(i).innerText();
  return `${text.match(/Ser(?:ies)?:?\s*\d+/i)?.[0] ?? ""}|${text.match(/Im \d+ \/ (\d+)/)?.[1] ?? ""}`;
};
const focusImage = async () => {
  // Keys go to the window; make sure no control has focus.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
};
const box = async (i = 0) => (await cell(i).boundingBox());

// ── active border ───────────────────────────────────────────────────────
if (want("border")) {
  await focusImage();
  await page.keyboard.press("Shift+Digit2"); // 1×2
  await page.waitForSelector('[data-drop-cell="1"]');
  await settle(500);
  // The frame layer of each viewport (a real border above the image).
  const outline = async (i) =>
    cell(i).evaluate((el) => {
      const frame = el.querySelector("[data-viewport-frame]");
      const s = frame ? getComputedStyle(frame) : null;
      return { width: s?.borderTopWidth ?? "none", color: s?.borderTopColor ?? "none", active: el.hasAttribute("data-active-viewport") };
    });
  const a0 = await outline(0);
  check("border: active viewport has a 3 px coloured outline", a0.active && a0.width === "3px" && !/rgba?\(0, 0, 0|transparent/.test(a0.color), JSON.stringify(a0));
  const b1 = await box(1);
  await page.mouse.click(b1.x + b1.width / 2, b1.y + b1.height / 2);
  await settle();
  const [c0, c1] = [await outline(0), await outline(1)];
  check("border: clicking another viewport moves the border", !c0.active && c1.active && c1.width === "3px", `${JSON.stringify(c0)} ${JSON.stringify(c1)}`);
  await shot("border");
}

// ── drag a series onto a viewport ───────────────────────────────────────
if (want("dnd")) {
  if (!(await cell(1).count())) {
    await focusImage();
    await page.keyboard.press("Shift+Digit2");
    await settle(500);
  }
  const cards = page.locator('nav[aria-label="Series"] li button');
  const n = await cards.count();
  check("dnd: the study has at least two series", n >= 2, `${n} series`);
  const before0 = await seriesText(0);
  const before1 = await seriesText(1);
  // Drag the card of the series NOT shown in cell 0 (by image count) onto cell 0.
  const count0 = before0.split("|")[1];
  let card = cards.nth(0);
  for (let i = 0; i < n; i += 1) {
    const counts = ((await cards.nth(i).innerText()).match(/\d+/g) ?? []).map(String);
    if (!counts.includes(count0)) {
      card = cards.nth(i);
      break;
    }
  }
  const cb = await card.boundingBox();
  const target = await box(0);
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2 + 20, cb.y + cb.height / 2 + 10, { steps: 4 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  const hint = await page.locator("text=Drop to show here").isVisible();
  check("dnd: dragging shows a drop hint on the viewport under the pointer", hint);
  await shot("dnd-hover");
  await page.mouse.up();
  await settle(1200);
  const after0 = await seriesText(0);
  const active0 = await cell(0).evaluate((el) => el.hasAttribute("data-active-viewport"));
  check("dnd: drop shows the series in that viewport and selects it", after0 !== before0 && active0, `${before0} → ${after0} (cell 1: ${before1})`);
}

// ── keyboard navigation ─────────────────────────────────────────────────
if (want("keys")) {
  await focusImage();
  await page.keyboard.press("Shift+Digit1"); // 1×1
  await page.waitForFunction(() => !document.querySelector('[data-drop-cell="1"]'));
  await settle(400);
  await page.keyboard.press("Home");
  await settle();
  const start = await imageNo();
  check("keys: Home goes to the first image", start?.at === 1, JSON.stringify(start));
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowDown");
  await settle();
  check("keys: ↓ ×3 moves three images", (await imageNo())?.at === 4, JSON.stringify(await imageNo()));
  await page.keyboard.press("ArrowUp");
  await settle();
  check("keys: ↑ moves back one", (await imageNo())?.at === 3);
  await page.keyboard.press("PageDown");
  await settle();
  const page10 = Math.max(1, Math.round(start.of / 10));
  check("keys: PgDn jumps ~10 % of the series", (await imageNo())?.at === 3 + page10, `${JSON.stringify(await imageNo())} step ${page10}`);
  await page.keyboard.press("PageUp");
  await settle();
  check("keys: PgUp jumps back", (await imageNo())?.at === 3);
  await page.keyboard.press("End");
  await settle();
  check("keys: End goes to the last image", (await imageNo())?.at === start.of);
  const s0 = await seriesText(0);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1200);
  const s1 = await seriesText(0);
  check("keys: → shows the next series in the active viewport", s1 !== s0, `${s0} → ${s1}`);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(1200);
  check("keys: ← goes back to the previous series", (await seriesText(0)) === s0, await seriesText(0));
  await page.keyboard.press("Shift+Digit4");
  await settle(500);
  check("keys: Shift+4 gives the 2×2 layout", (await page.locator("[data-drop-cell]").count()) === 4);
  await page.keyboard.press("Shift+Digit1");
  await settle(500);
  await page.keyboard.press("Shift+Slash"); // ?
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await sheet.waitFor({ timeout: 3000 }).catch(() => undefined);
  const sheetOk = await sheet.isVisible();
  const rows = sheetOk ? await sheet.locator("[data-shortcut-row]").count() : 0;
  check("keys: ? opens the cheat sheet", sheetOk && rows > 30, `${rows} rows`);
  await shot("cheat-sheet");
  await page.keyboard.press("Escape");
  await settle();
}

// ── re-map a shortcut in Settings ───────────────────────────────────────
if (want("remap")) {
  await page.getByRole("button", { name: /settings/i }).first().click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.waitFor();
  const row = dialog.locator('[data-shortcut-id="tool.w"]');
  await row.scrollIntoViewIfNeeded();
  await row.getByRole("button", { name: /Change the shortcut/ }).click();
  await page.keyboard.press("Shift+K");
  await settle();
  const shown = await row.locator("kbd").innerText();
  check("remap: the new key is recorded", /Shift\+K|⇧K/.test(shown), shown);
  // A clash is refused.
  await row.getByRole("button", { name: /Change the shortcut/ }).click();
  await page.keyboard.press("z");
  await settle();
  const clash = await row.getByRole("alert").innerText().catch(() => "");
  check("remap: a key already in use is refused with a reason", /already/.test(clash), clash);
  await shot("remap");
  await page.keyboard.press("Escape");
  await settle(400);
  await focusImage();
  await page.keyboard.press("b");
  await page.keyboard.press("Shift+K");
  await settle();
  const tool = await page.evaluate(() => document.body.dataset.toolCursor);
  check("remap: the new key selects Window / level", tool === "wl", tool);
  await page.keyboard.press("b");
  await page.keyboard.press("w");
  await settle();
  check("remap: the old key no longer does", (await page.evaluate(() => document.body.dataset.toolCursor)) === "scroll");
  // Back to the default.
  await page.getByRole("button", { name: /settings/i }).first().click();
  await dialog.waitFor();
  await dialog.locator('[data-shortcut-id="tool.w"]').getByRole("button", { name: /Restore the default/ }).click();
  await page.keyboard.press("Escape");
  await settle(400);
}

// ── cursors ─────────────────────────────────────────────────────────────
if (want("cursors")) {
  await focusImage();
  const b = await box(0);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  const cursorOnImage = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('[data-drop-cell="0"] .cs-viewport canvas');
      return canvas ? getComputedStyle(canvas).cursor : "none";
    });
  const expect = [
    ["b", "scroll", (c) => c.includes("url(") && c.includes("ns-resize")],
    ["w", "window / level", (c) => c.includes("url(")],
    ["z", "zoom", (c) => c.includes("url(") && c.includes("zoom-in")],
    ["p", "pan", (c) => c === "grab"],
    ["m", "length", (c) => c === "crosshair"],
    ["e", "ellipse", (c) => c === "crosshair"],
    ["a", "angle", (c) => c === "crosshair"],
    ["x", "probe", (c) => c === "crosshair"],
    ["Shift+E", "eraser", (c) => c.includes("url(")],
  ];
  const seen = new Set();
  for (const [key, name, ok] of expect) {
    await page.keyboard.press(key);
    await settle(120);
    const c = await cursorOnImage();
    check(`cursors: ${name} (${key})`, ok(c), c.slice(0, 60));
    if (c.includes("url(")) seen.add(c.slice(0, 200));
  }
  check("cursors: scroll, W/L, zoom and eraser are distinct", seen.size === 4, `${seen.size} distinct`);
  const ui = await page.evaluate(() => {
    const el = document.querySelector('[role="toolbar"] button');
    return el ? getComputedStyle(el).cursor : "";
  });
  check("cursors: the toolbar keeps a normal pointer", ui !== "crosshair" && !ui.includes("url("), ui);
  await page.keyboard.press("p");
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  const grabbing = await cursorOnImage();
  await page.mouse.up();
  check("cursors: pan shows a closed hand while dragging", grabbing === "grabbing", grabbing);
  await page.keyboard.press("b");
}

// ── annotations ─────────────────────────────────────────────────────────
if (want("annotate")) {
  await focusImage();
  const state = async () =>
    page.locator('[data-drop-cell="0"] [data-testid="annotation-state"]').evaluate((el) => ({
      onImage: Number(el.dataset.onImage),
      inSeries: Number(el.dataset.inSeries),
      selected: Number(el.dataset.selected),
      labels: Number(el.dataset.labels),
    }));
  await page.waitForSelector('[data-drop-cell="0"] [data-testid="annotation-state"]', { state: "attached", timeout: 15_000 });
  const b = await box(0);
  const P = (fx, fy) => [b.x + b.width * fx, b.y + b.height * fy];
  const drag = async (from, to) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...to, { steps: 10 });
    await page.mouse.up();
    await settle(300);
  };

  // Start from a plain click on empty image (ends any earlier gesture).
  await page.keyboard.press("b");
  await page.mouse.click(...P(0.1, 0.1));
  await settle(200);
  // Arrow, no prompt.
  await page.keyboard.press("y");
  const a1 = P(0.35, 0.35);
  const a2 = P(0.5, 0.5);
  await drag(a1, a2);
  let s = await state();
  check("annotate: an arrow draws with no prompt", s.onImage === 1 && dialogs === 0, `${JSON.stringify(s)} dialogs=${dialogs}`);
  check("annotate: the arrow has no label by default", s.labels === 0);

  // Inline label by double-click.
  const mid = [(a1[0] + a2[0]) / 2, (a1[1] + a2[1]) / 2];
  await page.mouse.dblclick(...mid);
  const input = page.getByTestId("annotation-label-input");
  const opened = await input.waitFor({ timeout: 3000 }).then(() => true, () => false);
  if (!opened) await shot("label-edit-missing");
  check("annotate: double-click opens an inline label field on the image", opened && dialogs === 0);
  if (opened) {
    await input.fill("Lesion");
    await shot("label-edit");
    await input.press("Enter");
    await settle(300);
  }
  s = await state();
  check("annotate: Enter saves the label", s.labels === 1, JSON.stringify(s));
  await page.mouse.dblclick(...mid);
  if (await input.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
    await input.fill("Changed");
    await input.press("Escape");
    await settle(300);
  }
  const text = (await page.locator('[data-drop-cell="0"] svg').evaluateAll((els) => els.map((e) => e.textContent ?? ""))).join(" ");
  check("annotate: Esc cancels the edit", text.includes("Lesion") && !text.includes("Changed"), text.slice(0, 80));

  // Select + Delete, undo / redo.
  await page.keyboard.press("b");
  await page.mouse.click(...mid);
  await settle(200);
  s = await state();
  const handles = await page.getByTestId("annotation-selection").locator("circle").count().catch(() => 0);
  check("annotate: click selects (highlight + handles)", s.selected === 1 && handles >= 2, `${JSON.stringify(s)} handles=${handles}`);
  await shot("selected");
  await page.keyboard.press("Delete");
  await settle();
  check("annotate: Delete removes the selected annotation", (await state()).onImage === 0);
  await page.keyboard.press("Control+z");
  await settle();
  check("annotate: Ctrl+Z brings it back", (await state()).onImage === 1);
  await page.keyboard.press("Control+y");
  await settle();
  check("annotate: Ctrl+Y deletes it again", (await state()).onImage === 0);
  await page.keyboard.press("Control+z");
  await settle();

  // A second measurement; right-click menu.
  await page.keyboard.press("m");
  await drag(P(0.6, 0.3), P(0.75, 0.3));
  check("annotate: a length measurement draws", (await state()).onImage === 2);
  await page.keyboard.press("b");
  await page.mouse.click(...P(0.68, 0.3), { button: "right" });
  const menu = page.getByRole("menu", { name: "Annotation" });
  const menuOk = await menu.waitFor({ timeout: 3000 }).then(() => true, () => false);
  const items = menuOk ? await menu.getByRole("menuitemradio").allInnerTexts() : [];
  check(
    "annotate: right-click opens Delete / Copy value / Delete all",
    menuOk && ["Delete", "Copy value", "Delete all on this image", "Delete all in series"].every((l) => items.some((t) => t.startsWith(l))),
    items.map((t) => t.split("\n")[0]).join(" | ")
  );
  await shot("context-menu");
  if (menuOk) {
    await menu.getByRole("menuitemradio", { name: /^Copy value/ }).click();
    await settle(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    check("annotate: Copy value puts the measurement on the clipboard", /Length \d+(\.\d)? mm/.test(clip), clip);
  }
  // Right-DRAG must stay window/level (no menu).
  await page.mouse.move(...P(0.2, 0.7));
  await page.mouse.down({ button: "right" });
  await page.mouse.move(...P(0.3, 0.75), { steps: 6 });
  await page.mouse.up({ button: "right" });
  await settle(300);
  check("annotate: right-drag windows without opening the menu", !(await menu.isVisible().catch(() => false)));

  await page.mouse.click(...P(0.12, 0.82), { button: "right" });
  await menu.waitFor({ timeout: 3000 }).catch(() => undefined);
  await menu.getByRole("menuitemradio", { name: /^Delete all on this image/ }).click().catch(() => undefined);
  await settle();
  check("annotate: Delete all on this image", (await state()).onImage === 0);
  await page.keyboard.press("Control+z");
  await settle();
  check("annotate: one Ctrl+Z restores all of them", (await state()).onImage === 2);

  // Delete all in series covers other images too.
  await page.keyboard.press("ArrowDown");
  await settle(300);
  await page.keyboard.press("m");
  await drag(P(0.3, 0.6), P(0.45, 0.6));
  await page.keyboard.press("b");
  s = await state();
  check("annotate: series count spans images", s.inSeries === 3 && s.onImage === 1, JSON.stringify(s));
  await page.mouse.click(...P(0.12, 0.82), { button: "right" });
  await menu.waitFor({ timeout: 3000 }).catch(() => undefined);
  const seriesItem = menu.getByRole("menuitemradio", { name: /^Delete all in series/ });
  const clicked = await seriesItem.click({ timeout: 3000 }).then(() => "clicked", (e) => String(e).split("\n")[0]);
  await settle();
  if (clicked !== "clicked") console.error("series item:", clicked, await menu.isVisible().catch(() => "?"));
  check("annotate: Delete all in series", (await state()).inSeries === 0, JSON.stringify(await state()));
  await page.keyboard.press("Control+z");
  await settle();
  check("annotate: undo restores the series", (await state()).inSeries === 3);

  // Eraser. Undo shows the image the annotations are on (the first one,
  // with the arrow and the first length).
  const beforeErase = await state();
  await page.keyboard.press("Shift+E");
  await page.mouse.click(...mid);
  await settle();
  s = await state();
  check(
    "annotate: the eraser deletes the annotation it clicks",
    s.onImage === beforeErase.onImage - 1 && s.inSeries === beforeErase.inSeries - 1,
    `${JSON.stringify(beforeErase)} → ${JSON.stringify(s)}`
  );
  await page.mouse.click(...P(0.1, 0.1));
  await settle();
  check("annotate: an eraser click on empty image deletes nothing", (await state()).inSeries === s.inSeries);
  await page.keyboard.press("Escape");
  await settle();
  check("annotate: Esc leaves the eraser", (await page.evaluate(() => document.body.dataset.toolCursor)) === "scroll");
}

// ── linked scroll / sync / reference lines ──────────────────────────────
if (want("sync")) {
  const count = async (i) => (await imageNo(i))?.of;
  await focusImage();
  await page.keyboard.press("Shift+Digit2");
  await page.waitForSelector('[data-drop-cell="1"]');
  await settle(600);
  // 1 mm series left, 5 mm series right (same frame of reference).
  const cards = page.locator('nav[aria-label="Series"] li button');
  const cardWith = async (n) => {
    for (let i = 0; i < (await cards.count()); i += 1) if (((await cards.nth(i).innerText()).match(/\d+/g) ?? []).includes(String(n))) return cards.nth(i);
    return null;
  };
  const dragTo = async (card, target) => {
    const cb = await card.boundingBox();
    const tb = await box(target);
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 12 });
    await page.mouse.up();
    await settle(1000);
  };
  if ((await count(0)) !== 300) await dragTo(await cardWith(300), 0);
  if ((await count(1)) !== 60) await dragTo(await cardWith(60), 1);
  // Same anatomy on both (first slice), then link + sync.
  for (const i of [1, 0]) {
    const b = await box(i);
    await page.mouse.click(b.x + b.width * 0.9, b.y + b.height * 0.5);
    await page.keyboard.press("Home");
    await settle(300);
  }
  await page.keyboard.press("F5");
  await settle(400);
  for (let k = 0; k < 5; k += 1) await page.keyboard.press("PageDown"); // 5 × 30 = 150 slices of 1 mm
  await settle(800);
  const left = await imageNo(0);
  const right = await imageNo(1);
  // 150 mm down the 1 mm stack ≈ 30 slices of the 5 mm stack.
  const expected = 1 + Math.round(((left?.at ?? 1) - 1) / 5);
  check("sync: scrolling one series moves the other to the same position", right && Math.abs(right.at - expected) <= 1, `left ${left?.at}/300 → right ${right?.at}/60 (expect ~${expected})`);
  await shot("sync-scroll");
  // Window / level sync.
  await page.keyboard.press("Shift+F5");
  await page.keyboard.press("3");
  await settle(500);
  const wl = async (i) => (await cell(i).innerText()).match(/W (-?\d+) · L (-?\d+)/)?.slice(1).join("/");
  check("sync: window / level follows the active viewport (Shift+F5)", (await wl(0)) === (await wl(1)) && !!(await wl(0)), `${await wl(0)} vs ${await wl(1)}`);
  // Zoom sync.
  await page.keyboard.press("Alt+F5");
  await page.keyboard.press("Control+Digit2");
  await settle(500);
  const zoom = async (i) => (await cell(i).innerText()).match(/Zoom (\d+)%/)?.[1];
  check("sync: zoom follows the active viewport (Alt+F5)", (await zoom(0)) === (await zoom(1)) && !!(await zoom(0)), `${await zoom(0)} vs ${await zoom(1)}`);
  // Reference lines need non-parallel planes: the coronal reformat on the
  // right (make-ortho-series.py), the axial stack active on the left.
  const coronal = await cardWith(47);
  if (coronal) await dragTo(coronal, 1);
  const lb = await box(0);
  await page.mouse.click(lb.x + lb.width * 0.9, lb.y + lb.height * 0.5);
  await settle(400);
  const lines = async (i) => cell(i).locator("svg line, svg path").count();
  const before = await lines(1);
  await page.keyboard.press("Control+F12");
  await settle(600);
  check("sync: reference lines draw the active axial slice on the coronal", !!coronal && (await lines(1)) > before, `${coronal ? "" : "no coronal series in the study; "}${before} → ${await lines(1)} svg strokes`);
  await shot("sync-reference-lines");
  // Off again so later groups start clean.
  await page.keyboard.press("Control+F12");
  await page.keyboard.press("F5");
  await page.keyboard.press("Shift+F5");
  await page.keyboard.press("Alt+F5");
  await settle(300);
}

// ── voice commands ──────────────────────────────────────────────────────
if (want("voice")) {
  const hasModel = existsSync(path.join(dist, "voice", "model.tar.gz"));
  if (!hasModel || !voiceWav) {
    const why = !hasModel ? "no voice model in this build (scripts/fetch-voice-model.py)" : "no --voice-wav";
    if (requireVoice) check("voice: model and spoken commands available", false, why);
    else console.error(`SKIP  voice: ${why}`);
  } else {
    check("voice: nothing loaded before the mic is switched on", voiceRequests.length === 0, voiceRequests.join(" "));
    const workersBefore = page.workers().length;
    await focusImage();
    await page.keyboard.press("Shift+Digit1");
    await settle(400);
    const mic = page.getByRole("button", { name: /^Voice commands/ });
    await mic.click();
    await page.waitForFunction(() => !!document.querySelector('[aria-label^="Voice commands on"]'), null, { timeout: 60_000 }).catch(() => undefined);
    const listening = await page.getByRole("button", { name: /^Voice commands on/ }).count();
    check("voice: the mic toggle starts listening (model loaded on demand)", listening === 1);
    check("voice: the recognizer runs in its own worker", page.workers().length > workersBefore, `${workersBefore} → ${page.workers().length}`);
    // The WAV says: "layout two", "lung window", "zoom in" (looped by Chromium).
    const heard = new Set();
    // The recording loops; give it two full passes to hear every phrase.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(heard.has("layout two ✓") && heard.has("lung window ✓"))) {
      const chip = await page.getByTestId("voice-heard").innerText().catch(() => "");
      if (chip) heard.add(chip.replace(/[“”]/g, ""));
      const cells = await page.locator("[data-drop-cell]").count();
      const wl = (await cell(0).innerText().catch(() => "")).match(/W (\d+) · L (-?\d+)/);
      if (cells === 2) heard.add("layout two ✓");
      if (wl && Number(wl[1]) === 1500 && Number(wl[2]) === -600) heard.add("lung window ✓");
      await page.waitForTimeout(250);
    }
    check("voice: “layout two” switches to two viewports", heard.has("layout two ✓"), [...heard].join(" | "));
    check("voice: “lung window” applies the lung preset", heard.has("lung window ✓"), [...heard].join(" | "));
    check("voice: what was heard is shown", [...heard].some((h) => /layout|lung|zoom/.test(h) && !h.includes("✓")), [...heard].join(" | "));
    await shot("voice-listening");
    await page.keyboard.press("Control+Shift+V");
    await page.waitForFunction(() => !document.querySelector('[aria-label^="Voice commands on"]'), null, { timeout: 10_000 }).catch(() => undefined);
    await settle(800);
    check("voice: switching off frees the recognizer (worker gone)", page.workers().length <= workersBefore, `${page.workers().length} workers`);
  }
}

const unexpected = consoleErrors.filter((e) => !/favicon|DevTools|GPU stall|WebGL|Failed to load resource/i.test(e));
check("no uncaught errors in the page", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed }, null, 2));
process.exit(failed.length ? 1 : 0);
