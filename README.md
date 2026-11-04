# FlowRad Viewer

A free DICOM viewer for the browser, Windows and macOS, at **viewer.flowrad.ai**. Signed-in users
can also anonymise teaching studies in the browser, then store, write up and share them.

- **Web viewer** (`/viewer`): drop a folder, ZIP or files. Nothing is uploaded and no account is needed.
- **Desktop** (`desktop/`): Tauri 2 app for Windows and macOS (and Linux) on the same viewer core.
  It opens folders, DICOMDIR, ZIPs and discs, and works fully offline.
- **Store and share**: browser-side anonymisation, Cloud Healthcare DICOMweb storage, history,
  findings, diagnosis, tags and markup, collections, view-only links (unknown or with findings,
  expiring, revocable), embeds and downloads. Plans are by stored-study count.

For education and research. Not for diagnostic use.

## Layout

| Path | What |
| --- | --- |
| `app/(site)/` | Marketing home and pricing (merged from flowrad-viewer-site) |
| `app/viewer/` | Free web viewer |
| `app/library`, `app/studies`, `app/collections`, `app/links`, `app/account` | Signed-in pages |
| `app/s/[token]`, `app/embed/[token]` | Share links and embeds |
| `app/api/` | Account API and the DICOMweb proxy |
| `lib/cloud/` | Anonymiser, store, identity, access, archive, shares, plans, downloads |
| `packages/viewer-core/` | `@flowrad/viewer-core`, shared by web and desktop |
| `components/viewer/`, `components/CornerstoneViewer.tsx` | Web viewer UI |
| `desktop/` | Desktop app (Rust shell + Vite renderer) |
| `deploy/gcp/` | Terraform and the deploy script for Cloud Run |
| `site/` | Shared FlowRad nav spec and renderer |

## Develop

```bash
npm ci
VIEWER_DEV_SIGN_IN=1 npm run dev      # http://localhost:3000
npm test                              # unit tests
npm run build                         # must pass before a commit (no --turbo)
```

Storing studies needs an archive: `ORTHANC_URL` (local Orthanc) or the Cloud Healthcare
variables. See [`docs/VIEWER_SAAS.md`](docs/VIEWER_SAAS.md) for all configuration, the GCP
setup and what is still to do. Desktop: [`desktop/README.md`](desktop/README.md).
