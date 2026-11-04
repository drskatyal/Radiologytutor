# Desktop downloads: release readiness

**Decision (Sanyam, 2026-11):** no public Windows or macOS download links until the desktop builds are
**code-signed** and **update themselves** (Tauri updater, signed with the release key). Self-updating
builds let us gate features behind plans later without asking anyone to reinstall.

Until then viewer.flowrad.ai shows **"Coming soon"** with a waitlist link (`support@flowrad.ai`) on both
desktop cards. `/download/windows` and `/download/macos` stay as stable links that lead to that section.

## What is wired already

| Piece | Where | State |
| --- | --- | --- |
| Updater public key + endpoint | `desktop/updater.json` (one committed file, public values only) | Points at `https://viewer.flowrad.ai/api/desktop/update` |
| Applying it to the build | `desktop/scripts/configure-updater.mjs` (run in `desktop-release.yml`; `--check` in `desktop-ci.yml`) | Writes `tauri.conf.json` and `FLOWRAD_UPDATE_BASE` for Rust. Refuses a private key in the public slot. Never reads or prints the private key. |
| Update channel | `app/api/desktop/update`, `/update/rollback`, `/config` + `lib/desktopChannel.ts` | Answers 204 (nothing to install) until a person pastes a signed `latest.json` into `LATEST` |
| Verify, install, rollback | `desktop/src-tauri/src/updates.rs` (unchanged logic) | Verifies every update and remote config against the baked-in public key |
| Site links | `lib/cloud/downloads.ts` → `offeredInstaller()` | A link appears only when **both** `DESKTOP_DOWNLOADS_LIVE=1` is set on Cloud Run **and** the manifest entry is `signed: true` |
| Publishing installers | `desktop-release.yml` → `publish-downloads` (manual) | **Refused** unless `TAURI_SIGNING_PRIVATE_KEY`, Apple and Windows signing secrets are all set; also checks `latest.json` |
| Account sign-in from the desktop | `/api/desktop/link*`, `/desktop/link`, `desktop/src/licence/account.ts` | Device-link flow: the app shows a code, the user confirms it in the browser, and the app gets a device token. Not shown in the app UI yet. |
| Plan / entitlement check | `lib/cloud/entitlements.ts`, `/api/desktop/entitlement`, `mergeAccountEntitlement()` | Scaffold. **Nothing is gated** (`PAID_FEATURES` is empty), and an unsigned answer can only turn features on. |

## What Sanyam must provide

Secrets go into **GitHub → repository Settings → Secrets and variables → Actions** (or Secret Manager for
the server). **Never in the repository, a PR, an issue, or a chat.**

1. **Updater signing key.**
   - `TAURI_SIGNING_PRIVATE_KEY`: the private key file's contents.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password.
   - The committed public key (`desktop/updater.json`, fingerprint `A5E2CD705936E39E`) was generated for
     0.8.2. If you hold its private half, use that.
   - If you don't, generate a new pair on your own machine (`npx @tauri-apps/cli signer generate -w ~/.tauri/flowrad-viewer.key`),
     put the **public** `.pub` contents (base64, exactly as Tauri prints them) into `desktop/updater.json`
     in a PR, and put the private key only in the secret.
   - Changing the public key is fine now because no public build has shipped. After public release it
     needs the rotation steps in `docs/UPDATES.md`.
2. **Apple (macOS).**
   - A **Developer ID Application** certificate exported as `.p12` → `APPLE_CERTIFICATE` (base64) +
     `APPLE_CERTIFICATE_PASSWORD` + `APPLE_SIGNING_IDENTITY`.
   - For notarisation, either `APPLE_API_ISSUER`, `APPLE_API_KEY` and `APPLE_API_PRIVATE_KEY` (App Store
     Connect API key, recommended), or `APPLE_ID`, `APPLE_PASSWORD` (app-specific) and `APPLE_TEAM_ID`.
   - Needs an Apple Developer Program membership.
3. **Windows.**
   - A code-signing identity. The workflow supports **Azure Artifact Signing** (Trusted Signing):
     secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` plus variables
     `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT` and `AZURE_SIGNING_PROFILE` (identity validation
     is done in the Azure portal).
   - An EV or OV certificate would need a different `signCommand`. Ask first.
4. **Entitlement signing key (before any feature is gated).** A separate ed25519 key held server-side
   (Secret Manager, for example `ENTITLEMENT_SIGNING_KEY`), whose public half ships in the app. The desktop
   will only honour a "feature off" from a signed answer. Not needed for the scaffold.
5. **Release hosting** (already in `docs/VIEWER_SAAS.md`): the GCP downloads bucket and the
   `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_RELEASE_SERVICE_ACCOUNT` and `GCS_DOWNLOADS_BUCKET` repository
   variables.

## Go-live checklist (in order)

1. Secrets 1–3 set. Cut a release (`desktop-v<version>` tag or manual run). Check that the release notes
   say the updates are signed, the macOS build is notarised, and the Windows build is signed.
2. Test the installers on the HP (Windows) and the MacBook. Install the previous signed version, then roll
   out the new one through `LATEST` (`lib/desktopChannel.ts`, a reviewed PR) and confirm the
   update-and-restart flow and the rollback flow.
3. Run `desktop-release` manually with **publish_downloads**. It refuses to publish without the signing
   secrets.
4. Set `DESKTOP_DOWNLOADS_LIVE=1` on the Cloud Run service. The site cards switch from "Coming soon" to
   download buttons with no code change.
5. Later, for freemium: move a feature into `PAID_FEATURES`, ship entitlement signing (item 4), and wire
   the desktop Settings sign-in to `desktop/src/licence/account.ts` through a Rust command, with the token
   stored in the OS keychain.
