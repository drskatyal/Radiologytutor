# RadLearn Viewer (desktop)

A free, offline DICOM viewer for Windows, macOS and Linux. Tauri 2 shell (Rust)
around a Vite + React renderer that reuses the web app's `lib/` (stack ordering,
window presets, cine, viewer runtime tuning) and `components/ui` design system.
Plan: [`docs/DESKTOP_PLAN.md`](../docs/DESKTOP_PLAN.md). Competitive benchmark:
[`docs/RADIANT_BENCHMARK.md`](../docs/RADIANT_BENCHMARK.md).

**Not for diagnostic use.**

## What it does

- **Opens** folders, individual files, DICOMDIR (index-driven, case-insensitive,
  ISO 9660 `;1` tolerant), zip archives (extracted once into the app cache, zip-slip
  safe), and CD / DVD / USB media (auto-detected on Windows, macOS and Linux).
  Drag-and-drop onto the window, "Open with…", and command-line paths.
- **Progressive open.** The Rust scanner parses headers on every core and streams
  them to the renderer in batches; the first series is on screen while a disc is
  still being read. Re-opening a study hits an on-disk scan cache keyed by
  path + size + mtime. The cache holds no patient identifiers.
- **Decodes locally**, in web workers: JPEG baseline/extended, JPEG lossless,
  JPEG-LS, JPEG 2000, HTJ2K, RLE, implicit/explicit LE, deflated LE (inflated
  in Rust), and multiframe instances.
- **Reads** with a series browser (decoded thumbnails, drag a series onto any
  viewport), layouts from 1×1 to 3×3, synchronized scrolling, reference lines,
  window/level with modality presets, zoom/pan/rotate/flip/invert, length,
  angle, Cobb angle, ellipse/rectangle/circle/freehand ROI with HU stats, probe,
  arrow, bidirectional, magnifier, cine, and RadiAnt-compatible keyboard
  shortcuts (F1 in the app).
- **MPR, 3D and fusion.**
  - MPR: axial, sagittal and coronal planes with linked crosshairs (a 3D
    cursor), oblique planes by dragging a line, and MIP / MinIP / average
    slabs.
  - 3D: volume rendering with presets.
  - PET/CT fusion in SUVbw, with a PET MIP.
  - Volumes are built before they are attached (≈2 s for 300 slices).
- **Exports.**
  - PNG or JPEG, for one image or a whole series.
  - Video: MP4 (H.264 via WebCodecs), or Motion-JPEG AVI where the OS has no
    encoder.
  - An anonymised DICOM copy (PS3.15 basic profile header scrub; free). The
    text overlay on exported images is anonymous by default, and file names
    never carry patient text.
- **Remembers** recently opened studies (paths and descriptions only).

## Develop

```bash
npm ci                      # repo root: the renderer imports ../lib and ../components
npm ci --prefix desktop
npm --prefix desktop run tauri dev
```

The renderer also runs in a plain browser (`npm --prefix desktop run dev`, then
open http://localhost:1420): opening falls back to the web loader
(`lib/localDicomFiles.ts`) and persistence to `localStorage`.

Linux needs the WebKitGTK toolchain:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev
```

## Test

```bash
npm --prefix desktop test                              # renderer unit tests
cargo test --manifest-path desktop/src-tauri/Cargo.toml
python3 desktop/scripts/make-fixtures.py --bench /tmp/fixtures   # every transfer syntax, DICOMDIR, zip, PET/CT
npx --prefix desktop tauri build --debug --no-bundle
xvfb-run -a desktop/scripts/fixture-matrix.sh desktop/src-tauri/target/debug/radlearn-viewer /tmp/fixtures
```

## Benchmark

```bash
B=desktop/src-tauri/target/release/radlearn-viewer
node desktop/scripts/bench.mjs coldstart $B --runs 6
node desktop/scripts/bench.mjs idle $B
node desktop/scripts/bench.mjs desktop $B /tmp/fixtures/bench/ct-1200 --runs 5
node desktop/scripts/bench.mjs browser /tmp/fixtures/ct-phantom     # the web loader, for before/after
```

On Windows use the `.exe` path; the `idle` mode reads RSS on Linux and macOS
(use Task Manager's "Memory" column on Windows).

## Build installers

```bash
npm --prefix desktop run tauri build      # .msi + .exe (Windows), .dmg + .app (macOS), .AppImage + .deb (Linux)
```

Signed release builds, notarisation and auto-update manifests are produced by
`.github/workflows/desktop-release.yml`; see that file for the secrets it needs.

## Privacy

- Opening, viewing and exporting never touch the network.
- The `dicom://` protocol serves only files the user opened, by index; the
  renderer cannot name an arbitrary path. There is no filesystem plugin.
- History stores paths, study descriptions, modalities and counts. The scan
  cache stores identity and geometry. Neither stores patient names or pixels.
