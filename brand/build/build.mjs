// Owl Scan icon set, generated from ONE source: brand/owlscan.svg (the approved
// master, kept byte-for-byte). Nothing here redraws the mark: every raster is
// Chromium's rendering of that file, at the target size.
//
//   node brand/build/build.mjs          # renders + writes every output
//   (then) python3 brand/build/pack.py  # .ico / .bmp packing
//   (then) npx --prefix desktop tauri icon desktop/app-icon.png -o desktop/src-tauri/icons
//
// brand/build/build.sh runs all three.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const at = (p) => path.join(root, p);
const GREEN = "#0F4D3A";
const master = readFileSync(at("brand/owlscan.svg"), "utf8");
const masterUri = `data:image/svg+xml;base64,${Buffer.from(master).toString("base64")}`;
const wordmark = readFileSync(at("brand/build/wordmark-path.svgfrag"), "utf8").trim();

// The master, verbatim, as the source file every product references.
for (const p of ["public/owlscan.svg", "public/favicon.svg", "app/icon.svg", "desktop/app-icon.svg"]) {
  mkdirSync(path.dirname(at(p)), { recursive: true });
  writeFileSync(at(p), master);
}

// Lockups: the master nested unchanged (only given a position and size) + the
// outlined "FlowRad" wordmark (geometric sans, outlined so no font is needed).
const nested = master.replace("<svg ", '<svg x="0" y="0" width="256" height="256" ');
const lockup = (fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="256" viewBox="0 0 900 256"><title>FlowRad</title>${nested}${wordmark.replace(/fill="#[0-9A-Fa-f]+"/, `fill="${fill}"`)}</svg>`;
writeFileSync(at("brand/flowrad-lockup.svg"), lockup(GREEN));
writeFileSync(at("brand/flowrad-lockup-dark.svg"), lockup("#FFFFFF"));

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});

/** Render HTML at w×h to PNG. */
async function shot(html, w, h, out, transparent = true) {
  // A fresh page per render: a reused one can stall on its font wait.
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: Math.max(w, 64), height: Math.max(h, 64) } });
  await page.setContent(`<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent">${html}</body></html>`);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  mkdirSync(path.dirname(at(out)), { recursive: true });
  await page.screenshot({ path: at(out), omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
}
const img = (w, h = w, style = "") => `<img src="${masterUri}" width="${w}" height="${h}" style="display:block;${style}">`;

// Brand PNGs, every size straight from the master.
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
for (const s of SIZES) await shot(img(s), s, s, `brand/png/owlscan-${s}.png`);
// Linux hicolor PNGs and the Tauri source (1024).
for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) copyFileSync(at(`brand/png/owlscan-${s}.png`), at(`desktop/src-tauri/icons/linux/${s}.png`));
copyFileSync(at("brand/png/owlscan-1024.png"), at("desktop/app-icon.png"));

// Web: favicon sources (packed into .ico by pack.py), PWA, Apple.
for (const s of [16, 32, 48]) copyFileSync(at(`brand/png/owlscan-${s}.png`), at(`brand/build/out/favicon-${s}.png`));
await shot(img(192), 192, 192, "public/icon-192.png");
await shot(img(512), 512, 512, "public/icon-512.png");
// iOS masks its own corners: the master on a full-bleed green square (no dark corners).
await shot(`<div style="background:${GREEN};width:180px;height:180px">${img(180)}</div>`, 180, 180, "public/apple-touch-icon.png", false);
// Maskable: full green, the master's owl at 80 % (inside the 80 % safe circle).
await shot(
  `<div style="background:${GREEN};width:512px;height:512px;display:flex;align-items:center;justify-content:center">${img(410)}</div>`,
  512,
  512,
  "public/icon-maskable-512.png",
  false
);

// Lockup PNGs.
const lockupUri = (fill) => `data:image/svg+xml;base64,${Buffer.from(lockup(fill)).toString("base64")}`;
await shot(`<img src="${lockupUri(GREEN)}" width="1200" height="341">`, 1200, 341, "brand/png/flowrad-lockup.png");
await shot(`<img src="${lockupUri("#FFFFFF")}" width="1200" height="341">`, 1200, 341, "brand/png/flowrad-lockup-dark.png");

// NSIS installer art (packed to 24-bit BMP by pack.py).
await shot(
  `<div style="width:150px;height:57px;background:#fff;display:flex;align-items:center;justify-content:flex-end;padding-right:10px;box-sizing:border-box">${img(36)}</div>`,
  150,
  57,
  "brand/build/out/nsis-header.png",
  false
);
await shot(
  `<div style="width:164px;height:314px;background:${GREEN};display:flex;flex-direction:column;align-items:center;padding-top:72px;box-sizing:border-box;gap:14px;font:600 13px system-ui,sans-serif;color:#fff;letter-spacing:.02em">${img(88)}<span>FlowRad Viewer</span></div>`,
  164,
  314,
  "brand/build/out/nsis-sidebar.png",
  false
);

// Desktop splash (pre-JS CSS in desktop/index.html): the master tile, inline.
const html = readFileSync(at("desktop/index.html"), "utf8");
const splash = html
  .replace(/url\("data:image\/svg\+xml[^"]*"\)/, `url("${masterUri}")`)
  .replace(/\/ \d+px \d+px/, "/ 56px 56px")
  .replace(/The FlowRad "Owl Scan" mark[^\n]*\n/, 'The FlowRad "Owl Scan" master (brand/owlscan.svg, inline)\n');
writeFileSync(at("desktop/index.html"), splash);

await browser.close();
console.log("rendered from brand/owlscan.svg");
