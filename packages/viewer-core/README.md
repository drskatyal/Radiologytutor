# @flowrad/viewer-core

The viewer's platform-neutral core: stack ordering and series fill, window presets
and VOI, MPR geometry and sessions, cine, hanging layouts, prefetch plans, scroll
feel, the slice scrollbar, DICOM overlay text and local-file study grouping.

**Fork-ready by rule.** Nothing here may import the RadLearn app (`@/lib`,
`@/components`, `next`, React), auth, cases or teaching code. `lib/viewerCoreBoundary.test.ts`
fails the build if it does. Apps plug in through adapters:

| concern | desktop (FlowRad Viewer, Tauri) | web (RadLearn) |
|---|---|---|
| files / study source | Rust scanner + `dicom://` protocol | DICOMweb (GCP Healthcare / Orthanc) via `/api/dicomweb` |
| storage | local database + scan cache | RadLearn cloud |
| PACS | DIMSE / DICOMweb from the app | server side |
| teaching, auth, cases | — | RadLearn adapters in `lib/` |

The old `lib/<module>.ts` paths remain as one-line re-exports, so existing imports
keep working; new code imports `@flowrad/viewer-core`.
