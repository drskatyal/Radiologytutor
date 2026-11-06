//! Self-update, rollback and the remote config / licence seam (docs/UPDATES.md).
//!
//! * **Updates.** The Tauri updater, driven from here so the app controls when
//!   it runs: the front end asks ~10 s after first paint and every 4 h, never
//!   during a study open. A newer version is downloaded in the background,
//!   verified against the ed25519 (minisign) public key baked into the build,
//!   and parked on disk (not in memory). The user sees "Update ready — Restart"
//!   and nothing installs until they choose it.
//! * **Rollback.** Before installing, the version being left is recorded. The
//!   new version must report healthy (front end up for a while after first
//!   paint) within [`MAX_UNHEALTHY_BOOTS`] launches; otherwise it is marked
//!   bad, never offered again, and the previous release is fetched from the
//!   rollback channel (same signature check) and installed. An install that
//!   never took (still the old version on the next launch) is counted and
//!   retried; after [`MAX_INSTALL_FAILURES`] that version is skipped.
//! * **Remote config / licence.** A signed JSON (same key) with feature flags
//!   and which features are paid, cached on disk and re-verified on every read,
//!   so it works offline. A licence is a signed token the user pastes in. With
//!   neither, everything is free: today nothing is paid.
//! * **Privacy.** Every request is a bare GET to a fixed URL: no query, no
//!   cookies, no install id, no study / patient / path data. Errors are logged
//!   only to a local file in the app data folder.

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

/// Where the update channel and config live (the Next site, `app/api/desktop`).
/// Overridable at build time for a staging channel.
pub const CHANNEL_BASE: &str = match option_env!("FLOWRAD_UPDATE_BASE") {
    Some(v) => v,
    None => "https://radiologytutor-production.up.railway.app",
};
/// Fallback when the site is down: GitHub's "latest published release" asset.
pub const GITHUB_LATEST: &str = "https://github.com/drskatyal/Radiologytutor/releases/latest/download/latest.json";

/// Launches a new version may take without reporting healthy before it is rolled back.
pub const MAX_UNHEALTHY_BOOTS: u32 = 2;
/// Installs that never took before that version is skipped.
pub const MAX_INSTALL_FAILURES: u32 = 3;

pub fn update_urls() -> Vec<String> {
    vec![format!("{CHANNEL_BASE}/api/desktop/update"), GITHUB_LATEST.to_string()]
}
pub fn rollback_url() -> String {
    format!("{CHANNEL_BASE}/api/desktop/update/rollback")
}
pub fn config_url() -> String {
    format!("{CHANNEL_BASE}/api/desktop/config")
}

// ---------------------------------------------------------------------------
// Persistent state + the rollback state machine (pure, unit-tested)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub from: String,
    pub to: String,
    /// Launches of `to` that have not (yet) reported healthy.
    pub boots: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateState {
    pub pending: Option<Pending>,
    /// Versions never to offer again (failed to start, or never installed).
    pub bad: Vec<String>,
    pub install_failures: BTreeMap<String, u32>,
    /// Version currently being rolled back from, while the rollback runs.
    pub rolling_back_from: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BootAction {
    Nothing,
    /// The new version failed to start healthily: reinstall `to` (the previous one).
    RollBack { from: String, to: String },
}

/// Run once per launch, before anything else touches updates.
pub fn on_boot(state: &mut UpdateState, current: &str) -> BootAction {
    if state.rolling_back_from.as_deref() == Some(current) {
        // A rollback was attempted and we are still on the bad version: don't
        // loop; the user keeps a working-enough app and the version stays bad.
        state.rolling_back_from = None;
    }
    let Some(p) = state.pending.as_mut() else { return BootAction::Nothing };
    if p.to == current {
        p.boots += 1;
        if p.boots > MAX_UNHEALTHY_BOOTS {
            let (from, to) = (p.from.clone(), p.to.clone());
            mark_bad(state, &to);
            state.pending = None;
            state.rolling_back_from = Some(to.clone());
            return BootAction::RollBack { from: to, to: from };
        }
    } else if p.from == current {
        // The installer ran but we are still the old version: it didn't take.
        let to = p.to.clone();
        let n = state.install_failures.entry(to.clone()).or_insert(0);
        *n += 1;
        if *n >= MAX_INSTALL_FAILURES {
            mark_bad(state, &to);
        }
        state.pending = None;
    } else {
        state.pending = None;
    }
    BootAction::Nothing
}

/// The running version is up and working: it is no longer on probation.
pub fn on_healthy(state: &mut UpdateState, current: &str) {
    if state.pending.as_ref().is_some_and(|p| p.to == current) {
        state.pending = None;
    }
    state.install_failures.remove(current);
}

fn mark_bad(state: &mut UpdateState, version: &str) {
    if !state.bad.iter().any(|v| v == version) {
        state.bad.push(version.to_string());
    }
}

/// Offer `remote` only if it is newer and not known bad.
pub fn offerable(state: &UpdateState, current: &str, remote: &str) -> bool {
    let (Ok(c), Ok(r)) = (semver::Version::parse(current), semver::Version::parse(remote)) else { return false };
    r > c && !state.bad.iter().any(|v| v == remote)
}

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn load_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_json<T: Serialize>(path: &Path, value: &T) {
    if let Ok(bytes) = serde_json::to_vec_pretty(value) {
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    data_dir(app).map(|d| d.join("updates.json"))
}

fn load_state(app: &AppHandle) -> UpdateState {
    state_path(app).map(|p| load_json(&p)).unwrap_or_default()
}

fn save_state(app: &AppHandle, state: &UpdateState) {
    if let Some(p) = state_path(app) {
        save_json(&p, state);
    }
}

/// Local-only log (app data folder). Never sent anywhere.
pub fn log(app: &AppHandle, line: &str) {
    use std::io::Write;
    let Some(dir) = data_dir(app) else { return };
    let path = dir.join("updates.log");
    // Keep it small: start over past 256 KB.
    if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{secs} {line}");
    }
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Called right after the app is built. Applies the rollback rule and, if
/// this version failed to start healthily, reinstalls the previous one in the
/// background (the user sees the app; Windows' installer then restarts it).
pub fn on_startup(app: &AppHandle) {
    let current = current_version(app);
    let mut state = load_state(app);
    let action = on_boot(&mut state, &current);
    save_state(app, &state);
    if let BootAction::RollBack { from, to } = action {
        log(app, &format!("rollback: {from} did not start healthily; reinstalling {to}"));
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = install_exact(&app, &rollback_url(), &to).await {
                log(&app, &format!("rollback to {to} failed: {e}"));
            }
        });
    }
}

async fn install_exact(app: &AppHandle, url: &str, version: &str) -> Result<(), String> {
    let want = version.to_string();
    let updater = app
        .updater_builder()
        .endpoints(vec![url.parse().map_err(|e| format!("{e}"))?])
        .map_err(|e| e.to_string())?
        .version_comparator(move |_current, release| release.version.to_string() == want)
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err(format!("the rollback channel does not offer {version}"));
    };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}

// ---------------------------------------------------------------------------
// Check → background download → "ready" → install on the user's restart
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct Staged(parking_lot::Mutex<Option<(tauri_plugin_updater::Update, PathBuf)>>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyUpdate {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
}

/// Check, and if a newer good version exists, download and verify it now.
/// `Ok(None)`: up to date (or no rollout). Errors are logged and returned;
/// the front end stays quiet unless the user pressed "Check now".
#[tauri::command]
pub async fn update_check(app: AppHandle, staged: tauri::State<'_, Staged>) -> Result<Option<ReadyUpdate>, String> {
    if let Some((u, path)) = staged.0.lock().as_ref() {
        if path.exists() {
            return Ok(Some(ReadyUpdate { version: u.version.clone(), current_version: u.current_version.clone(), notes: u.body.clone() }));
        }
    }
    let result = check_and_download(&app).await;
    match result {
        Ok(Some((update, path))) => {
            let ready = ReadyUpdate { version: update.version.clone(), current_version: update.current_version.clone(), notes: update.body.clone() };
            log(&app, &format!("update {} downloaded and verified", ready.version));
            *staged.0.lock() = Some((update, path));
            Ok(Some(ready))
        }
        Ok(None) => Ok(None),
        Err(e) => {
            log(&app, &format!("update check failed: {e}"));
            Err(e)
        }
    }
}

async fn check_and_download(app: &AppHandle) -> Result<Option<(tauri_plugin_updater::Update, PathBuf)>, String> {
    let state = load_state(app);
    let mut endpoints = Vec::new();
    for u in update_urls() {
        endpoints.push(u.parse().map_err(|e| format!("{e}"))?);
    }
    let bad = state.clone();
    let updater = app
        .updater_builder()
        .endpoints(endpoints)
        .map_err(|e| e.to_string())?
        .version_comparator(move |current, release| offerable(&bad, &current.to_string(), &release.version.to_string()))
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else { return Ok(None) };
    // `download` verifies the bytes against the baked-in public key.
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // One staged file at a time.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }
    let path = dir.join(format!("flowrad-viewer-{}.update", update.version));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    drop(bytes);
    Ok(Some((update, path)))
}

/// The user chose "Restart now": record the version being left (for
/// rollback), install the staged update and restart into it.
#[tauri::command]
pub async fn update_apply(app: AppHandle, staged: tauri::State<'_, Staged>) -> Result<(), String> {
    let Some((update, path)) = staged.0.lock().take() else { return Err("no update is ready".into()) };
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mut state = load_state(&app);
    state.pending = Some(Pending { from: current_version(&app), to: update.version.clone(), boots: 0 });
    save_state(&app, &state);
    log(&app, &format!("installing {}", update.version));
    if let Err(e) = update.install(bytes) {
        state.pending = None;
        *state.install_failures.entry(update.version.clone()).or_insert(0) += 1;
        save_state(&app, &state);
        log(&app, &format!("install of {} failed: {e}", update.version));
        return Err(e.to_string());
    }
    let _ = std::fs::remove_file(&path);
    app.restart();
}

/// The front end is up and working (first paint plus a settle period).
#[tauri::command]
pub fn update_mark_healthy(app: AppHandle) {
    let mut state = load_state(&app);
    let before = state.pending.clone();
    on_healthy(&mut state, &current_version(&app));
    if before != state.pending {
        log(&app, &format!("{} started healthily", current_version(&app)));
    }
    save_state(&app, &state);
}

// ---------------------------------------------------------------------------
// Signed envelopes: remote config and licence tokens
// ---------------------------------------------------------------------------

/// `payload` is the exact signed text; `signature` is the base64 minisign
/// signature (`tauri signer sign` output), same format as update signatures.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Envelope {
    pub payload: String,
    pub signature: String,
}

fn b64_text(s: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(s.trim()).map_err(|e| format!("base64: {e}"))?;
    String::from_utf8(bytes).map_err(|_| "not UTF-8".to_string())
}

/// Verify `env` against a Tauri-format public key (base64 of the minisign .pub file).
pub fn verify_envelope(pubkey_b64: &str, env: &Envelope) -> Result<(), String> {
    let key = PublicKey::decode(&b64_text(pubkey_b64)?).map_err(|e| format!("public key: {e}"))?;
    let sig = Signature::decode(&b64_text(&env.signature)?).map_err(|e| format!("signature: {e}"))?;
    key.verify(env.payload.as_bytes(), &sig, true).map_err(|e| format!("verify: {e}"))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteConfig {
    pub version: u32,
    pub issued_at: Option<String>,
    /// Feature flags. A flag not listed keeps the app's built-in default.
    pub flags: BTreeMap<String, bool>,
    /// Features that need a paid entitlement. Empty today: everything is free.
    pub paid_features: Vec<String>,
    /// Optional one-line notice shown in Settings (no tracking, no links required).
    pub message: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Licence {
    /// "paid" or "free".
    pub tier: String,
    /// RFC 3339; absent = no expiry.
    pub expires_at: Option<String>,
    /// Who it was issued to, shown in Settings only. Never sent anywhere.
    pub licensee: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entitlement {
    /// "free" | "paid".
    pub tier: String,
    /// Effective on/off per known flag or feature.
    pub features: BTreeMap<String, bool>,
    /// "default" | "cache" | "remote": where the config came from.
    pub source: String,
    pub expires_at: Option<String>,
    pub licensee: Option<String>,
    pub message: Option<String>,
}

/// Core viewing that is FREE on every tier, now and later: 3D MPR (multiplanar)
/// and the 3D volume. A remote config can never put these behind a paid
/// licence or switch them off; they are always reported on. Same list as
/// `FREE_CORE_FEATURES` in desktop/src/licence and flowrad-viewer's
/// lib/cloud/entitlements.ts. Names are stable API: never rename.
pub const FREE_CORE_FEATURES: &[&str] = &["mpr", "volume-3d"];

/// Combine config + licence. No config and no licence = free, everything on.
pub fn resolve_entitlement(config: Option<&RemoteConfig>, licence: Option<&Licence>, now_rfc3339: &str, source: &str) -> Entitlement {
    let paid = licence.is_some_and(|l| {
        l.tier == "paid" && l.expires_at.as_deref().map_or(true, |exp| exp > now_rfc3339)
    });
    let mut features = BTreeMap::new();
    if let Some(c) = config {
        for (k, v) in &c.flags {
            features.insert(k.clone(), *v);
        }
        for f in &c.paid_features {
            let on = features.get(f).copied().unwrap_or(true);
            features.insert(f.clone(), on && paid);
        }
    }
    // Free core wins over any flag or paid list.
    for f in FREE_CORE_FEATURES {
        if features.contains_key(*f) {
            features.insert((*f).to_string(), true);
        }
    }
    Entitlement {
        tier: if paid { "paid" } else { "free" }.into(),
        features,
        source: source.into(),
        expires_at: licence.filter(|_| paid).and_then(|l| l.expires_at.clone()),
        licensee: licence.filter(|_| paid).and_then(|l| l.licensee.clone()),
        message: config.and_then(|c| c.message.clone()),
    }
}

fn pubkey(app: &AppHandle) -> Option<String> {
    let v = app.config().plugins.0.get("updater")?.get("pubkey")?.as_str()?.to_string();
    (!v.starts_with("REPLACED")).then_some(v)
}

fn read_verified<T: for<'de> Deserialize<'de>>(app: &AppHandle, file: &str) -> Option<T> {
    let key = pubkey(app)?;
    let env: Envelope = serde_json::from_slice(&std::fs::read(data_dir(app)?.join(file)).ok()?).ok()?;
    verify_envelope(&key, &env).ok()?;
    serde_json::from_str(&env.payload).ok()
}

fn now_rfc3339() -> String {
    // Seconds since epoch → RFC 3339 UTC, without a date crate.
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem / 60) % 60, rem % 60)
}

/// The entitlement from what is on disk (works offline). Never blocks on the network.
#[tauri::command]
pub fn entitlement_get(app: AppHandle) -> Entitlement {
    let config: Option<RemoteConfig> = read_verified(&app, "remote-config.json");
    let licence: Option<Licence> = read_verified(&app, "licence.json");
    let source = if config.is_some() { "cache" } else { "default" };
    resolve_entitlement(config.as_ref(), licence.as_ref(), &now_rfc3339(), source)
}

/// Fetch the signed remote config (bare GET), verify, cache, and return the
/// new entitlement. Offline / 204 / bad signature: the cached one, unchanged.
#[tauri::command]
pub async fn config_refresh(app: AppHandle) -> Entitlement {
    match fetch_config(&app).await {
        Ok(Some(config)) => {
            let licence: Option<Licence> = read_verified(&app, "licence.json");
            return resolve_entitlement(Some(&config), licence.as_ref(), &now_rfc3339(), "remote");
        }
        Ok(None) => {}
        Err(e) => log(&app, &format!("config refresh failed: {e}")),
    }
    entitlement_get(app)
}

async fn fetch_config(app: &AppHandle) -> Result<Option<RemoteConfig>, String> {
    let Some(key) = pubkey(app) else { return Ok(None) };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(config_url()).send().await.map_err(|e| e.to_string())?;
    if res.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let env: Envelope = res.json().await.map_err(|e| e.to_string())?;
    verify_envelope(&key, &env)?;
    let config: RemoteConfig = serde_json::from_str(&env.payload).map_err(|e| e.to_string())?;
    if let Some(dir) = data_dir(app) {
        save_json(&dir.join("remote-config.json"), &env);
    }
    Ok(Some(config))
}

/// Store a licence token the user pasted (the signed envelope as JSON text).
#[tauri::command]
pub fn licence_set(app: AppHandle, token: String) -> Result<Entitlement, String> {
    let key = pubkey(&app).ok_or("this build has no signing key, so it can't check licences")?;
    let env: Envelope = serde_json::from_str(token.trim()).map_err(|_| "that isn't a FlowRad licence".to_string())?;
    verify_envelope(&key, &env).map_err(|_| "that licence isn't signed by FlowRad".to_string())?;
    let _: Licence = serde_json::from_str(&env.payload).map_err(|_| "that licence is malformed".to_string())?;
    let dir = data_dir(&app).ok_or("no app data folder")?;
    save_json(&dir.join("licence.json"), &env);
    Ok(entitlement_get(app))
}

#[tauri::command]
pub fn licence_clear(app: AppHandle) -> Entitlement {
    if let Some(dir) = data_dir(&app) {
        let _ = std::fs::remove_file(dir.join("licence.json"));
    }
    entitlement_get(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TESTDATA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/updates");

    fn test_key() -> String {
        std::fs::read_to_string(format!("{TESTDATA}/test.key.pub")).unwrap().trim().to_string()
    }
    fn signed(payload_file: &str) -> Envelope {
        Envelope {
            payload: std::fs::read_to_string(format!("{TESTDATA}/{payload_file}")).unwrap(),
            signature: std::fs::read_to_string(format!("{TESTDATA}/config-payload.json.sig")).unwrap().trim().to_string(),
        }
    }

    #[test]
    fn signed_config_verifies_and_tampered_config_is_rejected() {
        let key = test_key();
        assert!(verify_envelope(&key, &signed("config-payload.json")).is_ok());
        assert!(verify_envelope(&key, &signed("config-tampered.json")).is_err());
        // The real (baked-in) key did not sign the test payload.
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let real = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
        assert!(verify_envelope(real, &signed("config-payload.json")).is_err());
        assert!(verify_envelope(&key, &Envelope { payload: "{}".into(), signature: "!!".into() }).is_err());
    }

    #[test]
    fn baked_in_public_key_is_a_real_minisign_key() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let real = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
        assert!(PublicKey::decode(&b64_text(real).unwrap()).is_ok(), "tauri.conf.json pubkey must be a committed public key");
    }

    #[test]
    fn entitlement_defaults_to_free_with_everything_on() {
        let e = resolve_entitlement(None, None, "2026-11-02T00:00:00Z", "default");
        assert_eq!(e.tier, "free");
        assert!(e.features.is_empty(), "no flag is switched off by default");
        assert_eq!(e.source, "default");
        let cfg: RemoteConfig = serde_json::from_str(&signed("config-payload.json").payload).unwrap();
        let e = resolve_entitlement(Some(&cfg), None, "2026-11-02T00:00:00Z", "cache");
        assert_eq!(e.features.get("voice"), Some(&true));
        assert_eq!(e.features.get("newMprUi"), Some(&false));
    }

    #[test]
    fn mpr_and_volume_3d_are_free_core_on_every_tier() {
        assert_eq!(FREE_CORE_FEATURES, &["mpr", "volume-3d"]);
        let flags = FREE_CORE_FEATURES.iter().map(|f| (f.to_string(), false)).collect();
        let paid_features = FREE_CORE_FEATURES.iter().map(|f| f.to_string()).collect();
        let cfg = RemoteConfig { flags, paid_features, ..Default::default() };
        let now = "2026-11-02T00:00:00Z";
        let paid = Licence { tier: "paid".into(), expires_at: None, licensee: None };
        for licence in [None, Some(&paid)] {
            let e = resolve_entitlement(Some(&cfg), licence, now, "remote");
            for f in FREE_CORE_FEATURES {
                assert_eq!(e.features.get(*f), Some(&true), "{f} must stay on ({})", e.tier);
            }
        }
        // No config: not listed, so the app's default (on) applies.
        let e = resolve_entitlement(None, None, now, "default");
        assert!(FREE_CORE_FEATURES.iter().all(|f| !e.features.contains_key(*f)));
    }

    #[test]
    fn paid_features_need_an_unexpired_paid_licence() {
        let cfg = RemoteConfig { paid_features: vec!["cloudSync".into()], ..Default::default() };
        let now = "2026-11-02T00:00:00Z";
        assert_eq!(resolve_entitlement(Some(&cfg), None, now, "remote").features["cloudSync"], false);
        let paid = Licence { tier: "paid".into(), expires_at: Some("2027-01-01T00:00:00Z".into()), licensee: Some("Clinic".into()) };
        let e = resolve_entitlement(Some(&cfg), Some(&paid), now, "remote");
        assert_eq!((e.tier.as_str(), e.features["cloudSync"]), ("paid", true));
        let expired = Licence { expires_at: Some("2026-01-01T00:00:00Z".into()), ..paid };
        let e = resolve_entitlement(Some(&cfg), Some(&expired), now, "remote");
        assert_eq!((e.tier.as_str(), e.features["cloudSync"], e.licensee.clone()), ("free", false, None));
    }

    #[test]
    fn offers_only_newer_versions_that_are_not_bad() {
        let mut s = UpdateState::default();
        assert!(offerable(&s, "0.8.2", "0.8.3"));
        assert!(offerable(&s, "0.8.2", "0.10.0"));
        assert!(!offerable(&s, "0.8.2", "0.8.2"));
        assert!(!offerable(&s, "0.8.2", "0.8.1"));
        assert!(!offerable(&s, "0.8.2", "garbage"));
        s.bad.push("0.8.3".into());
        assert!(!offerable(&s, "0.8.2", "0.8.3"));
        assert!(offerable(&s, "0.8.2", "0.8.4"));
    }

    #[test]
    fn a_new_version_that_never_reports_healthy_is_rolled_back() {
        let mut s = UpdateState { pending: Some(Pending { from: "0.8.2".into(), to: "0.8.3".into(), boots: 0 }), ..Default::default() };
        for _ in 0..MAX_UNHEALTHY_BOOTS {
            assert_eq!(on_boot(&mut s, "0.8.3"), BootAction::Nothing);
        }
        assert_eq!(on_boot(&mut s, "0.8.3"), BootAction::RollBack { from: "0.8.3".into(), to: "0.8.2".into() });
        assert!(s.bad.contains(&"0.8.3".to_string()));
        assert!(s.pending.is_none());
        // Back on 0.8.2: 0.8.3 is never offered again.
        assert_eq!(on_boot(&mut s, "0.8.2"), BootAction::Nothing);
        assert!(!offerable(&s, "0.8.2", "0.8.3"));
        // A failed rollback (still 0.8.3 next launch) does not loop.
        let mut s2 = UpdateState { rolling_back_from: Some("0.8.3".into()), ..Default::default() };
        assert_eq!(on_boot(&mut s2, "0.8.3"), BootAction::Nothing);
        assert!(s2.rolling_back_from.is_none());
    }

    #[test]
    fn a_healthy_start_clears_probation() {
        let mut s = UpdateState { pending: Some(Pending { from: "0.8.2".into(), to: "0.8.3".into(), boots: 0 }), ..Default::default() };
        assert_eq!(on_boot(&mut s, "0.8.3"), BootAction::Nothing);
        on_healthy(&mut s, "0.8.3");
        assert!(s.pending.is_none());
        for _ in 0..5 {
            assert_eq!(on_boot(&mut s, "0.8.3"), BootAction::Nothing);
        }
    }

    #[test]
    fn an_install_that_never_takes_is_retried_then_skipped() {
        let mut s = UpdateState::default();
        for i in 1..=MAX_INSTALL_FAILURES {
            s.pending = Some(Pending { from: "0.8.2".into(), to: "0.8.3".into(), boots: 0 });
            assert_eq!(on_boot(&mut s, "0.8.2"), BootAction::Nothing);
            assert_eq!(s.install_failures["0.8.3"], i);
            assert_eq!(offerable(&s, "0.8.2", "0.8.3"), i < MAX_INSTALL_FAILURES);
        }
    }

    #[test]
    fn requests_carry_no_identifying_data() {
        // Every URL is fixed: no query string, no template the updater could
        // fill with target / arch / version, nothing derived from a study.
        for url in update_urls().into_iter().chain([rollback_url(), config_url()]) {
            assert!(url.starts_with("https://"), "{url}");
            assert!(!url.contains('?') && !url.contains("{{"), "{url}");
        }
    }

    #[test]
    fn rfc3339_now_is_well_formed() {
        let n = now_rfc3339();
        assert_eq!(n.len(), 20);
        assert!(n.starts_with("20") && n.ends_with('Z'));
    }
}
