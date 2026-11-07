// Mobile web check for the local viewer (/viewer/local) at 390 px (phone),
// 768 px (tablet) and 844×390 (phone landscape), with touch emulation.
//
//   node scripts/mobile-viewer-check.cjs <dicom-folder> [base-url]   (PW_CHROMIUM=/path/to/chrome optional)
//
// For each size it opens the folder's files, then asserts:
//   • the first image paints (canvas non-blank) and reports the time it took,
//   • no horizontal page scroll,
//   • the series drawer opens from the stage handle and closes with Escape,
//   • fullscreen gives the image the screen (canvas ≥ 55% of the viewport height)
//     and re-fits it (zoom ≤ 105%, nothing cropped).
// Exit 1 on any failure. Public sample data only (desktop/scripts/make-fixtures.py).

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const SIZES = [
  ["phone 390", { width: 390, height: 844 }],
  ["tablet 768", { width: 768, height: 1024 }],
  ["phone landscape", { width: 844, height: 390 }],
];

async function nonBlank(page) {
  return page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c || !c.width) return false;
    const probe = document.createElement("canvas");
    probe.width = 64;
    probe.height = 64;
    const ctx = probe.getContext("2d");
    ctx.drawImage(c, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
    return max > 40;
  });
}

(async () => {
  const dir = process.argv[2];
  const base = process.argv[3] || "http://localhost:3000";
  if (!dir) {
    console.error("usage: node scripts/mobile-viewer-check.cjs <dicom-folder> [base-url]");
    process.exit(2);
  }
  const files = fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());
  // PW_CHROMIUM: a preinstalled Chromium when the pinned Playwright has no browser download.
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM, args: ["--no-sandbox"] } : {});
  let failures = 0;
  for (const [name, viewport] of SIZES) {
    const problems = [];
    const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/viewer/local`);
      const consent = page.getByRole("button", { name: "Continue" });
      if (await consent.count()) await consent.first().click();
      const t0 = Date.now();
      await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(files);
      await page.waitForFunction(() => !!document.querySelector("canvas")?.width, null, { timeout: 30000 });
      let painted = false;
      for (let i = 0; i < 50 && !painted; i += 1) {
        painted = await nonBlank(page);
        if (!painted) await page.waitForTimeout(100);
      }
      const firstImageMs = Date.now() - t0;
      if (!painted) problems.push("first image never painted");

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) problems.push(`horizontal scroll of ${overflow}px`);

      await page.getByRole("button", { name: "Show series" }).tap();
      await page.getByRole("dialog").waitFor({ timeout: 3000 }).catch(() => problems.push("series drawer did not open"));
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached", timeout: 3000 }).catch(() => problems.push("drawer did not close"));

      await page.getByRole("button", { name: "Fullscreen" }).tap();
      await page.waitForTimeout(1500);
      const box = await page.locator("canvas").first().boundingBox();
      const share = box ? box.height / viewport.height : 0;
      if (share < 0.55) problems.push(`fullscreen image only ${Math.round(share * 100)}% of the screen height`);
      if (!(await nonBlank(page))) problems.push("blank after fullscreen");
      // Fit, not cropped: entering fullscreen must re-fit the image to the new shape.
      const zoomText = await page.evaluate(() => (document.body.innerText.match(/Zoom (\d+)%/) || [])[1]);
      const zoom = Number(zoomText);
      if (!(zoom > 0 && zoom <= 105)) problems.push(`fullscreen zoom ${zoomText}% (image cropped, expected a fit)`);

      console.log(`${problems.length ? "FAIL" : "OK  "} ${name.padEnd(16)} first image ${firstImageMs} ms · fullscreen image ${Math.round(share * 100)}% of height`);
    } catch (e) {
      problems.push(String(e).split("\n")[0]);
      console.log(`FAIL ${name}`);
    }
    for (const p of problems) console.log(`     ${p}`);
    failures += problems.length ? 1 : 0;
    await ctx.close();
  }
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
