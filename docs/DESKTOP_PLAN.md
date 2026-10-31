# A free standalone DICOM viewer for Mac and Windows

Date: 2026-10-30. Branch `claude/viewer-perf`.

> **Status (2026-10-31, branches `claude/desktop-viewer` → `-m2` → `-m3`).**
> Built so far: Stages 1–3, and Stage 4's DICOM Q/R plus teaching-case
> hand-off. See [`desktop/README.md`](../desktop/README.md).
>
> - **Approach.** The renderer is a Vite build that imports this repo's `lib/`
>   and `components/ui`, not a `next build` static export. The desktop needs
>   one page and no Next runtime.
> - **WKWebView spike (§1.1).** Still owed on a Mac, because it needs macOS
>   hardware.
> - **Performance and features vs RadiAnt.** See
>   [`docs/RADIANT_BENCHMARK.md`](RADIANT_BENCHMARK.md).

**Product goal.** A free, downloadable viewer that opens a study from a CD, a
USB stick or a folder, on macOS and Windows, with no account and no upload. It
is the same viewport the teaching product uses, so every improvement to one
improves the other — and it is the single cheapest way to put FlowRad in front
of a radiologist who has never heard of us.

**The market slot is genuinely open.** Horos — the free macOS viewer everyone
recommended — was withdrawn from distribution in 2025 and HorosProject.org is
permanently closed; the OsiriX project now directs former users to paid OsiriX
MD. MicroDicom is excellent but Windows-only and free only for non-commercial
use. 3D Slicer is cross-platform and free but is a research platform, not a
"read the disc the hospital gave me" viewer. Nobody is shipping a free,
maintained, cross-platform, pleasant one.

**What already works, today, in this branch.** `/viewer/local` opens a study
folder in the browser with no server involvement at all: `lib/localStudy.ts`
groups and orders it, `lib/localDicomFiles.ts` parses headers and streams pixels
off disk, and the viewer renders it. Verified live (`scripts/bench/smoke.mjs`,
14/14). The desktop build is a shell around that surface, not a rewrite.

---

## 1. Recommendation

**Tauri 2.** Not close, for this product.

| | Tauri 2 | Electron |
|---|---|---|
| Installer size | ~3–12 MB | ~85–180 MB |
| Idle RAM | ~40–60 MB | ~170 MB |
| Renderer | OS WebView (WebView2 on Windows, WKWebView on macOS) | bundled Chromium |
| Release engineering maturity | younger | the mature, battle-tested option |
| Auto-update | official plugin, **full-binary** updates, Ed25519-signed | `electron-updater`: differential updates, staged rollouts |
| Our team's languages | TS + a thin Rust shell | TS only |

The decisive arguments:

1. **Download size is the product.** This is a free utility a radiologist
   installs on a hospital workstation they may not own. "3 MB" and "180 MB" are
   different products. Tauri ships ~20–50× smaller because the WebView never
   travels over the wire.
2. **Memory is the product too.** A 1200-slice CTA already wants a gigabyte of
   decoded pixels (`lib/viewerRuntime.ts` caps it by device memory). Spending
   another ~120 MB of baseline on a second Chromium is a straight loss.
3. **We need almost nothing from Node.** The desktop shell's whole job is: open
   a file dialog, walk a directory, read bytes, and later speak DICOM over a
   socket. Rust does all of that better than Node does, and Tauri's capability
   model means the renderer gets exactly the filesystem scope we grant it.

### Where Electron would win, and why it does not here

- **Differential updates.** `electron-updater` ships diffs; Tauri downloads a
  full binary. But a full Tauri binary is ~5 MB — smaller than an Electron
  *diff*. The advantage inverts.
- **Mature signing/notarization tooling.** Real, and the main cost we are
  accepting. §4 spends the words on it.
- **Known-good Chromium on every platform.** The real risk, and the only one
  that could change the decision. See §1.1.

### 1.1 The one thing to validate before committing — WKWebView

The viewer is WebGL2 + WASM. On Windows, Tauri's WebView2 *is* Chromium, so
behaviour matches what we already test. On macOS it is **WKWebView**, and that
is where Cornerstone3D's own caveats live: `core.init()` logs a warning on iOS
that "norm16 texture not supported, you can turn on the preferSizeOverAccuracy
flag to use native data type, but be aware of the inaccuracy of the rendering
in high bits" — and `canRenderFloatTextures()` returns false on iOS. macOS
WKWebView is not iOS, but it is the same engine family, and a 16-bit CT
rendered through a path that silently loses low bits is a *clinical* defect,
not a cosmetic one.

**Spike, before any packaging work:** load `/viewer/local` with a 12-bit CT in
WKWebView and check three things — `getSupportedTextureFormats().norm16`,
whether the measured HU of a known ROI matches the browser, and the scroll
frame rate. If norm16 is unavailable, `preferSizeOverAccuracy` is the
documented workaround and must be enabled *with the accuracy caveat shown in
the UI*, or Electron becomes the right answer for macOS only. Budget: one day.

Two smaller WKWebView unknowns worth checking in the same spike:
`SharedArrayBuffer` (needs COOP/COEP, which Tauri's custom protocol can set)
and whether WASM SIMD is enabled for the JPEG 2000 / HTJ2K codecs.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Tauri shell (Rust)                                           │
│   • native open dialogs (file / folder)                      │
│   • recursive directory walk, DICOMDIR read                  │
│   • chunked file reads over a custom protocol                │
│   • later: C-FIND / C-MOVE SCU, DICOM print, local index     │
└───────────────────────┬──────────────────────────────────────┘
                        │ Tauri commands + `flowrad://` protocol
┌───────────────────────▼──────────────────────────────────────┐
│ Renderer — the SAME code as the web app                      │
│   components/CornerstoneViewer.tsx      (unchanged)          │
│   components/viewer/LocalStudyViewer.tsx (file source swap)   │
│   lib/localStudy.ts                     (unchanged, pure)    │
│   lib/localDicomFiles.ts                (one seam, §3)       │
│   lib/viewerRuntime.ts / prefetchPlan   (unchanged)          │
└──────────────────────────────────────────────────────────────┘
```

The renderer is built by the same `next build`, exported static for the
desktop target. No second viewer, no second scroll feel, no second set of
window presets to keep in sync. Every §4 item in `docs/VIEWER_BENCHMARK.md`
lands in both products at once.

### Why the split is already in the right place

`lib/localStudy.ts` has **no imports at all** — it is pure arithmetic over
header records, and it is where the decisions that matter live (what counts as
DICOM, how series group, what order a stack scrolls in). `lib/localDicomFiles.ts`
is the only module that knows about `File` and the browser. That is exactly the
seam the desktop build needs, and it exists because it was built that way, not
because it will be refactored later.

---

## 3. Implementation stages

### Stage 0 — done in this branch (web)

- `lib/localStudy.ts` — DICM magic (at offset 128 *and* 0, because anonymisers
  write preamble-less files), DICOMDIR and junk recognition, study/series
  grouping, instance ordering along the slice normal → InstanceNumber →
  natural file-name order, multiframe image counts. 23 tests.
- `lib/localDicomFiles.ts` — header-only reads (first 256 KB, parse stopped at
  PixelData), lazy import of `dicom-parser` and the Cornerstone loader, frame
  fan-out, progress reporting, cancel.
- `ViewerSource` gained an `imageIds` kind; `/viewer/local` renders it with the
  full toolbar, slice scrollbar, keyboard, cine, measurements and MPR.
- Verified: 14/14 live checks, `/viewer/local` first-load JS 8 kB / 193 kB.

**Known limitation, stated rather than hidden:** DICOMDIR is *detected and
skipped*, because we read every file in the selection anyway and the image
headers are the authority on grouping. That is correct for a folder drop and
wrong for media where the index is the only way to find the images. Closing it
is `docs/VIEWER_BENCHMARK.md` P1.9.

### Stage 1 — the shell (≈1 week after the §1.1 spike)

```
desktop/
  src-tauri/
    Cargo.toml
    tauri.conf.json
    src/main.rs          # open dialogs, directory walk, chunked reads
    capabilities/        # fs scope limited to user-chosen paths
```

- `next build` with `output: "export"` for the desktop target only — the
  current `output: "standalone"` stays for Cloud Run. The desktop bundle needs
  exactly two routes (`/viewer/local` and a minimal shell), nothing
  server-rendered, no API routes.
- One new seam in `lib/localDicomFiles.ts`: a `LocalFileSource` interface with
  `list()` and `read(path, start, end)`. The web implementation wraps `File`;
  the Tauri implementation calls a command. Nothing above that line changes.
- **Capability scope matters.** Tauri 2's permission model means we grant
  filesystem read only to directories the user picked in a dialog. A viewer
  that can read `$HOME` is a liability in a hospital; one that can read the
  folder you opened is not.
- File associations: `.dcm`, `.dicom`, and "Open With" for extensionless files.
  Open-on-double-click and open-on-drop-onto-dock/taskbar.

### Stage 2 — what makes it feel native (≈1 week)

- Native menu bar: File → Open Folder / Open Files / Recent, View → layout and
  window presets, Help → the keyboard sheet we already have.
- Recent studies list, persisted locally. **Paths only, never pixels or
  patient identifiers**, and a one-click "forget".
- Remember window geometry, last layout, last window preset per modality.
- Offline by construction: no telemetry by default, no network calls on the
  local path at all. Say so on the download page and mean it — that claim is
  the reason a hospital lets this on a workstation.

### Stage 3 — distribution (§4)

### Stage 4 — the things only a desktop app can do (later)

- **DICOM Q/R (C-FIND / C-MOVE / C-GET) and C-STORE SCP.** A browser cannot
  speak the DICOM upper-layer protocol; this is the one capability that makes a
  desktop viewer categorically more useful than our web one. Rust has
  `dicom-rs`. This is also the on-ramp to "pull the prior from your PACS".
- **A local study index** so a 50 GB teaching archive on an external drive is
  searchable without re-walking it.
- **Teaching-case hand-off.** "Send this study to my FlowRad studio" — the
  desktop viewer becomes the ingest path for teachers, running the existing
  de-identification (`lib/deid.ts`) *before* anything leaves the machine. That
  is a materially better compliance story than a browser upload, and it is the
  commercial reason to build the free viewer.

---

## 4. Packaging, signing, notarisation, updates

### macOS

- **Artefacts:** `.app` inside a `.dmg`, universal binary (`aarch64` +
  `x86_64`) so one download serves Apple Silicon and Intel.
- **Signing:** Apple Developer Program ($99/yr) → *Developer ID Application*
  certificate. Sign with hardened runtime enabled; Tauri signs the app bundle
  and its frameworks during `tauri build`.
- **Notarisation:** required, or Gatekeeper refuses to open a downloaded app.
  Submit with `notarytool` using an App Store Connect API key (not an
  app-specific password — API keys are revocable per-key and work in CI), then
  **staple** the ticket so first launch works offline. A hospital workstation
  often has no outbound internet; an unstapled app fails there.
- **Entitlements:** the default set, minus anything we do not need. We need no
  camera, no microphone, no network on the local path. Fewer entitlements is a
  shorter security review.

### Windows

- **Artefacts:** MSI (WiX) for managed/IT deployment and NSIS for the
  double-click installer. Hospitals deploy by MSI; individuals download the
  NSIS one.
- **Signing — use Azure Artifact Signing** (the GA name for what was previewed
  as Trusted Signing). It is Microsoft's recommended service for apps
  distributed outside the Store, is ~$10/month for an organisation, and a
  signed MSI installs on Windows 11 with Smart App Control on **without a
  block**. Certificates are short-lived (renewed daily, 24-hour validity) and
  signatures are timestamped, so artefacts stay valid after certificate
  expiry. It does **not** issue EV certificates and there is no plan to —
  which is fine, because we are not signing drivers.
- **SmartScreen reputation** still has to accumulate. Expect warnings on early
  downloads even when correctly signed. Mitigation: ship from a stable
  publisher identity, do not re-key, and give the download page a checksum.
- **Requirement to state on the download page:** WebView2 runtime. It is
  pre-installed on Windows 11 and on current Windows 10, but the installer
  should use Tauri's bootstrapper option for the few machines without it.

### Linux (free, so do it)

AppImage + `.deb`. No signing ceremony, no notarisation, and it is where a lot
of research imaging lives. Low cost, real goodwill.

### Auto-update

- Tauri's **updater plugin**: a static JSON manifest (or a 200/204 endpoint)
  with `version`, `url` and `signature` per `OS-ARCH` key, and every artefact
  signed with a project Ed25519 key generated by `tauri signer generate`. The
  private key lives only in CI secrets.
- Updates are **full binaries**, not diffs. At ~5 MB that is acceptable; it is
  the main thing we give up versus `electron-updater`.
- **Give the user control.** Check on launch, prompt, never auto-install
  silently. A viewer that changes under a radiologist mid-read is a defect, and
  a locked-down hospital machine may forbid background downloads outright — so
  ship a "never check" setting and a manual-download page that stays current.
- Release channel: `stable` only to begin with. A `beta` channel is cheap to
  add later and expensive to add under pressure.

### CI

GitHub Actions matrix (`macos-14` for the universal build, `windows-latest`,
`ubuntu-22.04`), `tauri-action` to build and draft a release, then notarise on
macOS and sign on Windows in the same job so secrets never leave it. Gate on
`npm run build && npm test && node scripts/bench/smoke.mjs` — the smoke check
runs headless Chrome, so it does not prove WKWebView, but it does prove the
renderer surface did not regress.

### Costs, annual

| item | cost |
|---|---|
| Apple Developer Program | $99/yr |
| Azure Artifact Signing | ~$120/yr |
| Release hosting | $0 (GitHub Releases) |
| **Total** | **~$220/yr** |

---

## 5. Risks, with mitigations

| risk | why it matters | mitigation |
|---|---|---|
| **WKWebView lacks `norm16`** | 16-bit CT rendered with silent precision loss is a clinical defect | the §1.1 spike *before* packaging; `preferSizeOverAccuracy` with the caveat surfaced in the UI; Electron for macOS only as the fallback |
| Memory on a 2 GB CTA | the OS kills the process, not the tab | `lib/viewerRuntime.ts` already caps the cache by device memory; the desktop build can read real total RAM instead of the clamped `navigator.deviceMemory` |
| "Is this diagnostic?" | a free viewer that looks diagnostic will be used as one | state **not for diagnostic use** in the About box, the download page and the window title, the way dwv does |
| PHI on disk | a recent-files list that leaks patient names | store paths only; never cache pixels or identifiers; one-click forget |
| SmartScreen / Gatekeeper friction on day one | downloads stall before anyone sees the product | sign and notarise from the first public build, publish checksums, never re-key |
| Scope creep into a diagnostic workstation | we cannot win that fight and should not try | the desktop viewer's job is *open a disc well* and *hand a study to the studio*; Q/R is the only Stage-4 item, and it is deliberately last |

---

## 6. What was implemented now, and what was deliberately not

**Implemented (this branch):** the entire local-open vertical on the web —
`lib/localStudy.ts`, `lib/localDicomFiles.ts`, the `imageIds` viewer source,
`components/viewer/LocalStudyViewer.tsx`, `/viewer/local`, 30 new tests, and a
live 14/14 browser check. That is Stage 0, finished, and it is useful on its
own: anyone can read a study CD in a browser today.

**Deliberately not started:** the `desktop/` directory, the Tauri
configuration, any signing credential, any CI release job. Those are the
"first small steps" the brief ruled out until the §1.1 WKWebView spike has
been run, because a rendering-accuracy failure there changes the framework
choice and would throw the packaging work away.

---

## Sources

- [OsiriX — Horos FAQ: "the Horos product has been withdrawn from distribution"](https://www.osirix-viewer.com/horos/faq/)
- [MicroDicom viewer](https://microdicom.com/)
- [Tauri v2 — Updater plugin](https://v2.tauri.app/plugin/updater/)
- [Microsoft Learn — Code signing options for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Microsoft — Windows support for the Trusted Signing program (KB5022661)](https://support.microsoft.com/en-gb/topic/kb5022661-windows-support-for-the-trusted-signing-formerly-azure-code-signing-program-4b505a31-fa1e-4ea6-85dd-6630229e8ef4)
- [devclass — Azure Artifact Signing general availability](https://www.devclass.com/security/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/4079554)
- [Electron Forge — Signing a Windows app](https://www.electronforge.io/guides/code-signing/code-signing-windows)
- [dwv — "not certified for diagnostic use"](https://github.com/ivmartel/dwv)
