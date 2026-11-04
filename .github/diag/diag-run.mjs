// TEMPORARY (claude/084-mac-start diagnosis; removed before hand-off).
// Launch the app N times with FLOWRAD_DIAG=1 and print its FLOWRAD_* lines.
// usage: node diag-run.mjs <app> <runs> [study]
import { spawn } from "node:child_process";

const [app, runsArg, study] = process.argv.slice(2);
const runs = Number(runsArg ?? 3);
for (let i = 0; i < runs; i += 1) {
  await new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(app, study ? [study] : [], {
      env: { ...process.env, FLOWRAD_BENCH: "1", FLOWRAD_BENCH_EXIT: "1", FLOWRAD_DIAG: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pending = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    console.log(`----- run ${i + 1}${study ? " (study)" : ""}`);
    child.stdout.on("data", (d) => {
      pending += d;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const l of lines) {
        if (l.startsWith("FLOWRAD_BENCH ")) {
          const r = JSON.parse(l.slice(14));
          const keep = {};
          for (const k of ["firstPaintMs", "nativeFirstPaintMs", "windowBuiltMs", "webviewBuiltMs", "navStartMs", "navDoneMs", "jsStartMs", "webviewNavStartMs", "gpuWarmMs", "pageTiming", "firstImageMs", "firstImagePaintedMs", "openAtProcessMs", "scanCalledMs", "firstHeaderMs", "firstSeriesHungMs", "viewChunksMs", "firstViewportSentMs", "nativeFirst", "native"]) if (r[k] !== undefined) keep[k] = r[k];
          console.log(`REPORT +${Math.round(performance.now() - t0)}ms ${JSON.stringify(keep)}`);
          if (r.trace) console.log(`TRACE ${r.trace.map(([l, ms]) => `${ms} ${l}`).join(" | ")}`);
        } else if (l.startsWith("FLOWRAD_")) console.log(l.slice(0, 400));
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
