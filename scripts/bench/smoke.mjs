// Headless smoke check of the real viewer UI.
//
//   node scripts/bench/smoke.mjs [http://127.0.0.1:3123/cornerstone]
//
// Opens the running app's Cornerstone spike page (which loads the bundled
// offline sample, so no archive is needed), waits for the viewport to paint,
// and asserts the things a unit test cannot see:
//
//   • the canvas exists and has non-black pixels (a frame actually rendered)
//   • the corner readout names a slice and a window
//   • the slice scrollbar is present with the right ARIA values
//   • the cine transport and the window-preset menu are in the toolbar
//   • the viewport is focusable, and ArrowDown moves the slice
//   • switching to MPR reports a result (planes or an explained refusal)
//
// Drives Chrome over the DevTools Protocol with Node's built-in WebSocket —
// no puppeteer dependency. Prints a JSON report and exits non-zero on failure.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_UNDER_TEST = process.argv[2] ?? "http://127.0.0.1:3123/cornerstone";
const DEBUG_PORT = Number(process.env.SMOKE_CDP_PORT ?? 9333);
// Set to student | author | super_admin to sign in through /api/auth/demo
// first. Needed for any page that reads pixels through /api/dicomweb, which
// refuses an anonymous caller.
const DEMO_ROLE = process.env.SMOKE_DEMO_ROLE?.trim() || null;

/** Mint a demo session and return the cookie to plant, or null. */
async function demoCookie(origin) {
  if (!DEMO_ROLE) return null;
  const res = await fetch(`${origin}/api/auth/demo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: DEMO_ROLE }),
  });
  if (!res.ok) throw new Error(`demo sign-in failed: ${res.status} ${await res.text()}`);
  const header = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  for (const line of header) {
    const match = /^flowrad_demo=([^;]+)/.exec(line);
    if (match) return { name: "flowrad_demo", value: match[1] };
  }
  throw new Error("demo sign-in returned no flowrad_demo cookie");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchChrome(profileDir) {
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--hide-scrollbars",
      "--window-size=1400,1000",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const logs = [];
  chrome.stdout.on("data", (d) => logs.push(String(d)));
  chrome.stderr.on("data", (d) => logs.push(String(d)));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return { chrome, logs, version: await res.json() };
    } catch {
      /* not up yet */
    }
    await wait(100);
  }
  chrome.kill("SIGKILL");
  throw new Error(`Chrome never opened a CDP port:\n${logs.join("")}`);
}

/** Minimal CDP client: one target, Runtime.evaluate only. */
async function connect() {
  // Open blank, plant the session cookie, THEN navigate — a page that needs
  // /api/dicomweb must not make its first request unauthenticated.
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, {
    method: "PUT",
  });
  const target = await res.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const consoleLines = [];
  // Domains are enabled below, before navigation, so the page's first console
  // line is captured.
  socket.addEventListener("error", () => {
    // The socket closes when Chrome is killed at the end of the run. Nothing
    // is in flight by then, and an unhandled 'error' event would make the
    // process exit non-zero after a clean report.
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    // Page console + network failures, so a blank viewport can be diagnosed.
    if (message.method === "Runtime.consoleAPICalled") {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(" ");
      consoleLines.push(`${message.params.type}: ${text}`);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      consoleLines.push(
        `exception: ${message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text}`
      );
      return;
    }
    if (message.method === "Network.responseReceived") {
      const { status, url } = message.params.response;
      if (status >= 400) consoleLines.push(`http ${status}: ${url}`);
      return;
    }
    if (message.method === "Network.loadingFailed") {
      consoleLines.push(`netfail: ${message.params.errorText}`);
      return;
    }
    if (message.method === "Log.entryAdded") {
      consoleLines.push(`${message.params.entry.level}: ${message.params.entry.text}`);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await send("Runtime.enable", {});
  await send("Log.enable", {});
  await send("Network.enable", {});
  const origin = new URL(URL_UNDER_TEST).origin;
  const cookie = await demoCookie(origin);
  if (cookie) {
    await send("Network.setCookie", {
      name: cookie.name,
      value: cookie.value,
      url: origin,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });
  }
  await send("Page.enable", {});
  await send("Page.navigate", { url: URL_UNDER_TEST });

  return {
    send,
    consoleLines,
    close: () => socket.close(),
    async evaluate(fnBody) {
      const result = await send("Runtime.evaluate", {
        expression: `(async () => { ${fnBody} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text ??
            "evaluate failed"
        );
      }
      return result.result.value;
    },
  };
}

const CHECKS = [];
function check(name, ok, detail) {
  CHECKS.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const profileDir = await mkdtemp(join(tmpdir(), "flowrad-smoke-"));
  const { chrome, logs } = await launchChrome(profileDir);
  let page;
  try {
    page = await connect();

    // /viewer/local has nothing to show until a file is chosen. Feed it the
    // bundled sample through the real file input so the whole local-open path
    // runs: header parse, grouping, frame fan-out, stack load.
    if (new URL(URL_UNDER_TEST).pathname.startsWith("/viewer/local")) {
      const injected = await page.evaluate(`
        const deadline = Date.now() + 30000;
        let input = null;
        while (Date.now() < deadline) {
          const inputs = [...document.querySelectorAll('input[type="file"]')];
          input = inputs.find((el) => !el.hasAttribute("webkitdirectory")) ?? null;
          if (input) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!input) return { ok: false, why: "no file input on the page" };
        const res = await fetch("/dicom/emri_small.dcm");
        if (!res.ok) return { ok: false, why: "sample DICOM missing: " + res.status };
        const bytes = await res.arrayBuffer();
        const file = new File([bytes], "SAMPLE/IM000001", { type: "application/dicom" });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, bytes: bytes.byteLength };
      `);
      check("the local file input accepts a dropped DICOM file", injected.ok, JSON.stringify(injected));
      if (!injected.ok) throw new Error(injected.why);
    }

    // Wait for the viewport to report a slice readout, which only happens
    // after setStack resolves and a frame has rendered.
    const ready = await page.evaluate(`
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const readout = document.querySelector(".imaging-readout");
        const canvas = document.querySelector('[role="img"][data-viewer-tool] canvas');
        if (readout && canvas && canvas.width > 0) {
          return { readout: readout.textContent.replace(/\\s+/g, " ").trim(),
                   width: canvas.width, height: canvas.height };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    `);
    check("the viewport paints a frame and publishes a readout", ready != null, JSON.stringify(ready));
    if (!ready) {
      console.error("\n--- page console ---");
      for (const line of page.consoleLines.slice(-40)) console.error(line);
      throw new Error("viewer never painted");
    }

    const pixels = await page.evaluate(`
      const canvas = document.querySelector('[role="img"][data-viewer-tool] canvas');
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      // A WebGL canvas cannot be read back with 2d getImageData; copy it.
      const bitmap = await createImageBitmap(canvas);
      const off = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = off.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let nonBlack = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) nonBlack += 1;
      }
      return { nonBlack, total: data.length / 4, gl: Boolean(gl) };
    `);
    check(
      "the rendered frame has non-black pixels",
      pixels.nonBlack > pixels.total * 0.01,
      `${pixels.nonBlack}/${pixels.total} lit, webgl=${pixels.gl}`
    );

    check(
      "the readout names a slice and a window",
      /\d+\s*\/\s*\d+/.test(ready.readout),
      ready.readout
    );

    // Open timings from lib/viewerTiming.ts (User Timing measures). On a
    // converted series (lib/dicomCdn) first-preview < full-quality; on
    // DICOMweb there is no preview and full quality is the first pixel.
    // Waits up to 15 s for the full-quality swap.
    const timings = await page.evaluate(`
      const read = () => Object.fromEntries(
        performance.getEntriesByType("measure")
          .filter((m) => m.name.startsWith("radlearn:navigation-to-"))
          .map((m) => [m.name.replace("radlearn:navigation-to-", ""), Math.round(m.duration)])
      );
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && read()["full-quality"] == null) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return read();
    `);
    console.log(`TIMING  ${JSON.stringify(timings)}`);

    const scrollbar = await page.evaluate(`
      const el = document.querySelector('[role="slider"][aria-label="Slice"]');
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return {
        now: el.getAttribute("aria-valuenow"),
        max: el.getAttribute("aria-valuemax"),
        text: el.getAttribute("aria-valuetext"),
        widthPx: Math.round(box.width),
        heightPx: Math.round(box.height),
      };
    `);
    check(
      "the slice scrollbar is on the stack with ARIA values",
      scrollbar && Number(scrollbar.max) > 1 && scrollbar.heightPx > 40,
      JSON.stringify(scrollbar)
    );

    const toolbar = await page.evaluate(`
      const labels = [...document.querySelectorAll('[role="toolbar"] button')]
        .map((b) => b.getAttribute("aria-label") || b.textContent.trim());
      const fps = document.querySelector('[role="toolbar"] select');
      return { labels, fpsOptions: fps ? [...fps.options].map((o) => o.value) : null };
    `);
    check(
      "the cine transport is in the toolbar",
      toolbar.labels.some((l) => /cine/i.test(l)) && Array.isArray(toolbar.fpsOptions),
      `${toolbar.labels.filter((l) => /cine/i.test(l)).join(", ")} · fps ${toolbar.fpsOptions}`
    );
    check(
      "window presets, invert and reset are in the toolbar",
      toolbar.labels.some((l) => /window presets/i.test(l)) &&
        toolbar.labels.includes("Invert") &&
        toolbar.labels.includes("Reset view"),
      toolbar.labels.join(" | ")
    );

    const keyboard = await page.evaluate(`
      const host = document.querySelector('[role="img"][data-viewer-tool]');
      const readSlice = () => {
        const text = document.querySelector(".imaging-readout")?.textContent ?? "";
        const match = text.replace(/\\s+/g, " ").match(/(\\d+)\\s*\\/\\s*(\\d+)/);
        return match ? Number(match[1]) : null;
      };
      host.focus();
      const focused = document.activeElement === host;
      const before = readSlice();
      host.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await new Promise((r) => setTimeout(r, 800));
      const after = readSlice();
      host.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      await new Promise((r) => setTimeout(r, 800));
      const home = readSlice();
      host.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const tool = host.getAttribute("data-viewer-tool");
      return { focused, before, after, home, tool };
    `);
    check("the viewport is focusable", keyboard.focused, JSON.stringify(keyboard));
    check(
      "ArrowDown advances the slice",
      keyboard.after != null && keyboard.before != null && keyboard.after === keyboard.before + 1,
      `${keyboard.before} -> ${keyboard.after}`
    );
    check("Home jumps to the first slice", keyboard.home === 1, `slice ${keyboard.home}`);
    check("a digit picks the left-button tool", keyboard.tool === "Zoom", `tool ${keyboard.tool}`);

    const cine = await page.evaluate(`
      const readSlice = () => {
        const text = document.querySelector(".imaging-readout")?.textContent ?? "";
        const match = text.replace(/\\s+/g, " ").match(/(\\d+)\\s*\\/\\s*(\\d+)/);
        return match ? Number(match[1]) : null;
      };
      const button = [...document.querySelectorAll('[role="toolbar"] button')]
        .find((b) => /play cine/i.test(b.getAttribute("aria-label") || ""));
      if (!button) return { ran: false };
      const before = readSlice();
      button.click();
      await new Promise((r) => setTimeout(r, 1200));
      const during = readSlice();
      const pause = [...document.querySelectorAll('[role="toolbar"] button')]
        .find((b) => /pause cine/i.test(b.getAttribute("aria-label") || ""));
      pause?.click();
      await new Promise((r) => setTimeout(r, 400));
      return { ran: true, before, during, pausedLabelFound: Boolean(pause) };
    `);
    check(
      "cine advances the stack and can be paused",
      cine.ran && cine.during != null && cine.during !== cine.before && cine.pausedLabelFound,
      JSON.stringify(cine)
    );

    const mpr = await page.evaluate(`
      const toggle = [...document.querySelectorAll("button")]
        .find((b) => /3 planes|mpr/i.test(b.getAttribute("aria-label") || b.textContent || ""));
      if (!toggle) return { found: false };
      toggle.click();
      const deadline = Date.now() + 40000;
      let last = null;
      while (Date.now() < deadline) {
        const layout = document.querySelector("[data-mpr-layout]");
        const planes = document.querySelectorAll('[aria-label$=" plane"]').length;
        const notice = document.querySelector('[role="status"]')?.textContent?.trim() || null;
        last = { state: layout?.getAttribute("data-mpr-layout") ?? null, planes, notice };
        if (last.state === "live" && planes >= 3) return { found: true, ...last, live: true };
        if (notice) return { found: true, ...last, explained: true };
        await new Promise((r) => setTimeout(r, 500));
      }
      return { found: true, ...last, explained: false };
    `);
    check(
      "the MPR toggle either builds three planes or explains why it cannot",
      mpr.found && ((mpr.live && mpr.planes >= 3) || (mpr.explained && Boolean(mpr.notice))),
      JSON.stringify(mpr)
    );

    const pageErrors = page.consoleLines.filter((line) => /^(error|exception)/i.test(line));
    check(
      "no page errors or uncaught exceptions",
      pageErrors.length === 0,
      pageErrors.slice(0, 3).join(" | ") || "clean"
    );
    if (process.env.SMOKE_VERBOSE) {
      console.error("\n--- page console ---");
      for (const line of page.consoleLines) console.error(line);
    }
  } finally {
    page?.close();
    chrome.kill("SIGKILL");
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    if (process.env.SMOKE_VERBOSE) console.error(logs.join(""));
  }

  const failed = CHECKS.filter((entry) => !entry.ok);
  console.log(`\n${CHECKS.length - failed.length}/${CHECKS.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
