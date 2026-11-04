# FlowRad Viewer — engineering guide

FlowRad Viewer is a free DICOM viewer (web, Windows, macOS) at **viewer.flowrad.ai**, plus
store-and-share for signed-in users: anonymise in the browser, store, write up, share view-only.
Architecture and decisions: [`docs/VIEWER_SAAS.md`](docs/VIEWER_SAAS.md). Desktop:
[`desktop/README.md`](desktop/README.md). Extraction history: [`EXTRACTION.md`](EXTRACTION.md).

## Non-negotiables

- **Patient data.** Never commit, log or print patient identifiers or secrets. Screenshots and
  fixtures use synthetic or public anonymised data only. Stored studies are anonymised in the
  browser (`lib/cloud/anonymize.ts`) and gated again on the server (`lib/cloud/ingestGate.ts`).
  Never add a path that stores or proxies un-gated bytes.
- **Free viewing stays free and local.** `/viewer` makes no upload and needs no account.
- **Viewer UX rules:**
  - Voice commands are full phrases ("bone window", never "bone"). `lib/voiceCommands.test.ts` enforces it.
  - Multi-monitor UI (pop-out, monitor picker, "next monitor" commands) appears only with
    **two or more** monitors (`lib/screens.ts` on the web, `hasMultipleMonitors` on desktop).
  - No download-size notice on the voice toggle (the status card shows a percentage only).
  - Every voice command is listed in help (web `ViewerHelp`, desktop help sheet).
- **Design system.** Use `components/ui/` primitives and Tailwind tokens (brand green accent).
  Inline styles only for dynamic geometry. The marketing pages use the ported site CSS
  (`app/(site)/site.css`, scoped under `.fr-site`) and the shared FlowRad nav. Brand files in
  `public/brand` are official: never redraw or recolour them.
- **Seams.** Store: `lib/cloud/store.ts`. Identity: `lib/cloud/session.ts` + `lib/cloud/auth.ts`.
  Archive: `lib/cloud/archive.ts` (+ `lib/imagingBackend.ts`). Access: `lib/cloud/access.ts`.
  Route handlers pass the session user's id, never one from the request.
- **Viewer core** lives in `packages/viewer-core` (no app/auth imports; `lib/viewerCoreBoundary.test.ts`).
- **Plugins:** this repo holds only the extension point (`docs/PLUGINS.md`): contract, host, loader,
  panel. Never add a plugin here; they live in a separate repo and are OFF by default (pinned by SHA-256).
- **3D MPR is free core** (`FREE_CORE_FEATURES` in `lib/cloud/entitlements.ts`): never gate it.

## Workflow

- `npm test` and `npm run build` must pass before a commit. Don't use `--turbo`.
- `python3 site/render-flowrad-nav.py --check` and `(cd site && sha256sum --check shared/flowrad-nav.sha256)` for nav changes.
- Open PRs only. Never merge or deploy from a task.
