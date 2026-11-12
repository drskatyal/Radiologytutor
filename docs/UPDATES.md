# Desktop updates, rollback and the licence seam

FlowRad Viewer 0.8.2 is the first desktop build that can update itself (Windows and macOS). This page covers the signing key, where the update manifest lives, how a release is rolled out and pulled, how a failed update rolls back, and the remote-config / licence hook that lets us charge later without a reinstall.

## What the app does

| When | What |
|---|---|
| Launch | Applies the rollback rule (one small file read, no network). |
| ~10 s after first paint, then every 4 h | Asks the update channel. Skipped while a study is opening, and when "Check for updates automatically" is off in Settings. |
| Newer, good version found | Downloads it in the background, **verifies the ed25519 signature** against the public key baked into the app, and parks it on disk. |
| Downloaded | Shows a non-blocking banner: **Update ready: Restart now / Later**. Nothing installs until the user clicks Restart now. |
| ~20 s after first paint | The running version reports "healthy", which ends its post-update probation. |
| Any failure (offline, 404, bad signature, failed install) | Silent. It's written to `updates.log` in the app data folder and retried on the next cycle. **Check now** in Settings says what happened. |

Code: `desktop/src-tauri/src/updates.rs` (Rust: check, download, verify, install, rollback, config, licence) and `desktop/src/components/useUpdater.ts` (schedule and banner). The schedule rules are in `desktop/src/updateSchedule.ts`.

## Privacy

Every request is a **bare GET to a fixed URL**: no query string, no cookies, no install id, no account, no study, patient or path data. Unit tests enforce it: `requests_carry_no_identifying_data` in `updates.rs`, and `desktop/src/updates.test.ts`. The server routes read nothing from the request and log nothing. There is no telemetry.

## The signing key

Updates are signed with a minisign (ed25519) key.

- **Public key:** committed in `desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. Every build bakes it in, so every installed copy only accepts updates and remote config signed by the matching private key. **Never change it**: copies in the field would stop accepting updates.
- **Private key:** never committed. Store it as repository secrets:
  - `TAURI_SIGNING_PRIVATE_KEY`: the private key file's contents.
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password. Empty for the key generated for 0.8.2. Re-encrypting it with a password is recommended, with `tauri signer generate` and the same key, or a rotation as below.
- **Without the private key:** the release still builds and the app still verifies updates. But that release's own bundles aren't signed as updates, so the release can't be offered as an update or used as a rollback target. **Add the secret before the 0.8.2 release build** so 0.8.2 can be a rollback target for 0.8.3.
- **Rotating the key** (only if it leaks): ship one release signed with the OLD key whose `tauri.conf.json` carries the NEW public key, then switch the secret.

## Where the manifest lives

The app asks, in order:

1. `https://learn.flowrad.ai/api/desktop/update`: our site (`app/api/desktop/update/route.ts`), serving `LATEST` from `lib/desktopChannel.ts`.
2. `https://github.com/drskatyal/Radiologytutor/releases/latest/download/latest.json`: GitHub's latest *published* release. This is a fallback only; drafts never resolve here.

`LATEST` is `null` until a person rolls a release out. `null` answers **204 No Content**, which the app reads as "no update". Setting it back to `null` stops a rollout within minutes. The response is cached for 5 minutes, and the app checks every 4 h.

Why our site rather than only GitHub: the release workflow makes **draft** releases only. A draft's `latest.json` is not reachable, and we want the rollout to be a reviewed, revertible change we control, with a kill switch and a rollback channel. The bundles themselves still download from the GitHub release.

## Rolling out a release

1. **Build.** Start the `desktop-release` workflow by hand on the integration branch (Actions → desktop-release → Run workflow). It builds Windows and the universal macOS app into a **draft** release with the signed `latest.json`. Its `updater-manifest` job checks the manifest has Windows and macOS, HTTPS URLs and signatures, and uploads it as the `updater-manifest` artifact.
2. **HP test** the installers from the draft.
3. **Publish** the GitHub release. This is a person's decision, not CI's; the bundle URLs only work once it is published.
4. **Open a PR to `lib/desktopChannel.ts`:**
   - Paste the release's `latest.json` into `LATEST`.
   - Move the previous `LATEST` into `ROLLBACK`; it is the version a failed update falls back to.
   - `lib/desktopChannel.test.ts` and `isManifest` reject a malformed paste.
   - After the orchestrator releases the merge hold, GCP Admin deploys the reviewed Cloud Run revision. Installed copies pick it up within 4 h. A merge alone does not authorize or trigger deployment.
5. **Pull a bad release:** set `LATEST` back to `null` (or to the previous manifest) and merge.

## Rollback

Tauri has no built-in rollback, so the app does it itself with the same signed mechanism:

- **Probation.** Before installing, the app records `{from, to}` in `updates.json` (app data folder). Each launch of `to` counts a boot until it reports healthy, about 20 s after first paint.
- **Failed start.** If `to` launches more than **2** times without reporting healthy (crashes, a blank window, a hang), the next launch:
  - marks `to` as bad, so it is never offered again;
  - fetches the previous version from `/api/desktop/update/rollback` (`ROLLBACK`);
  - verifies its signature and installs it.

  On Windows the installer restarts the app; on macOS the app restarts itself.
- **Failed install.** If the installer runs but the app is still the old version on the next launch, it is counted and retried on the next cycle. After **3** failures that version is skipped.
- **No loop.** If the rollback itself fails, the app stays on the version it has and doesn't try again.

**Limits, honestly:**

- **Crash before startup.** A version that crashes *before* the Tauri app is built (before `on_startup` runs) can't roll itself back. The user reinstalls the previous installer from the GitHub release.
- **Rollback channel must be set.** Rollback needs `ROLLBACK` to be set and that release to have been signed, which means `TAURI_SIGNING_PRIVATE_KEY` was set when it was built. Rollback from 0.8.3 to 0.8.2 needs 0.8.2's release built with the key.
- **Platform differences:**
  - **Windows:** the NSIS/MSI installer runs in passive mode, so the user sees a short progress window.
  - **macOS:** the `.app` bundle is replaced in place.
- **Not verified on hardware yet.** None of this has been run on a real Windows or Mac machine. It is unit-tested; the HP test of 0.8.3 is its first end-to-end run.

## Remote config and licence (the "charge later" seam)

**Interface:** `desktop/src/licence/index.ts` provides:

- `getEntitlement()` → `{ tier: "free" | "paid", features, source: "default" | "cache" | "remote", expiresAt?, licensee?, message? }`;
- `isEnabled(flag, fallback = true)`;
- `isPaid()`, `setLicence(token)`, `clearLicence()`.

**Defaults:** free, with every feature that ships today on. An unreachable, empty or unsigned config never switches anything off.

**Remote config.** `GET /api/desktop/config` serves `REMOTE_CONFIG` from `lib/desktopChannel.ts`, a signed envelope `{ "payload": "<exact JSON text>", "signature": "<base64 minisign signature>" }`. The payload looks like this:

```json
{ "version": 1, "issuedAt": "2026-12-01T00:00:00Z",
  "flags": { "newMprUi": false },
  "paidFeatures": [],
  "message": null }
```

**How the app handles it:**

- It's fetched with each update check and verified against the same public key.
- It's cached on disk and re-verified on every read, so it works offline.
- A tampered or unsigned response is ignored.

**Licence.** A licence is the same kind of envelope with payload `{ "tier": "paid", "expiresAt": "2027-12-31T23:59:59Z", "licensee": "Clinic name" }`. The user pastes it once; it is checked offline and expires on its own. A feature listed in `paidFeatures` is on only with an unexpired paid licence. Today the list is empty.

**Signing a config or a licence.** Write the payload to a file, then:

```bash
npx @tauri-apps/cli signer sign -f flowrad-updater.key -p "" payload.json
```

Then put the file's text in `payload` and the printed "Public signature" in `signature`.

**Not built yet:**

- the Settings UI for pasting a licence (the command and module exist);
- licence issuing (a Stripe webhook that signs tokens, behind `lib/payments.ts`, per ARCHITECTURE.md P3).
