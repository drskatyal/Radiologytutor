//! Optional sign-in to RadLearn, and "Send study to RadLearn".
//!
//! Off by default and never required: the viewer is fully usable offline. When
//! a teacher signs in, the viewer can hand a study to their RadLearn studio —
//! anonymized HERE, on this machine, before a single byte leaves it, then
//! posted in small batches to the same `/api/upload` the web uploader uses
//! (which runs its own de-identification gate on arrival as well).
//!
//! Requests go from Rust, not the webview, so there is no CORS surface and the
//! session cookie is never visible to page script.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::anonymize::{anonymize_to_bytes, AnonymizeOptions, UidMap};
use crate::store::{data_path, write_json};

/// Baked in at build time by the release workflow (`RADLEARN_SERVER_URL`);
/// empty in a local build, where the user types their RadLearn address.
pub const DEFAULT_SERVER: &str = match option_env!("RADLEARN_SERVER_URL") {
    Some(url) => url,
    None => "",
};
const BATCH: usize = 8;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    server: String,
    email: String,
    name: Option<String>,
    cookie: String,
}

fn session_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    data_path(app, "radlearn-session.json")
}

fn load(app: &tauri::AppHandle) -> Option<Session> {
    let bytes = std::fs::read(session_file(app).ok()?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn save(app: &tauri::AppHandle, session: &Session) -> Result<(), String> {
    let path = session_file(app)?;
    write_json(&path, &serde_json::to_value(session).map_err(|e| e.to_string())?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("RadLearnViewer/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

fn normalize_server(server: Option<String>) -> Result<String, String> {
    let s = server.unwrap_or_default().trim().trim_end_matches('/').to_string();
    let s = if s.is_empty() { DEFAULT_SERVER.trim_end_matches('/').to_string() } else { s };
    if s.is_empty() {
        Err("Enter your RadLearn address (for example https://learn.yourhospital.org).".into())
    } else if s.starts_with("https://") || s.starts_with("http://localhost") || s.starts_with("http://127.0.0.1") {
        Ok(s)
    } else if s.starts_with("http://") {
        Err("RadLearn sign-in requires an https:// address.".into())
    } else {
        Ok(format!("https://{s}"))
    }
}

#[tauri::command]
pub fn sync_status(app: tauri::AppHandle) -> Value {
    match load(&app) {
        Some(s) => json!({ "signedIn": true, "server": s.server, "email": s.email, "name": s.name }),
        None => json!({ "signedIn": false, "server": DEFAULT_SERVER }),
    }
}

#[tauri::command]
pub async fn sync_sign_in(
    app: tauri::AppHandle,
    server: Option<String>,
    email: String,
    password: String,
) -> Result<Value, String> {
    let server = normalize_server(server)?;
    let response = client()?
        .post(format!("{server}/api/auth/sign-in/email"))
        .header("Origin", &server)
        .json(&json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|e| format!("Could not reach {server}. Check the address and your connection. ({e})"))?;
    let status = response.status();
    let cookies: Vec<String> = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|v| v.split(';').next().map(str::to_string))
        .collect();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() || cookies.is_empty() {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Email or password is incorrect.");
        return Err(message.to_string());
    }
    let name = body
        .pointer("/user/name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let session = Session { server: server.clone(), email: email.clone(), name: name.clone(), cookie: cookies.join("; ") };
    save(&app, &session)?;
    Ok(json!({ "signedIn": true, "server": server, "email": email, "name": name }))
}

#[tauri::command]
pub async fn sync_sign_out(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(session) = load(&app) {
        // Best effort: revoke server-side, but always forget locally.
        let _ = client()?
            .post(format!("{}/api/auth/sign-out", session.server))
            .header("Origin", &session.server)
            .header(reqwest::header::COOKIE, &session.cookie)
            .send()
            .await;
    }
    let _ = std::fs::remove_file(session_file(&app)?);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadProgress {
    sent: usize,
    total: usize,
}

/// Anonymize and upload a study. Returns the server's last batch response
/// (study/series UIDs the create-case flow can pick up).
#[tauri::command]
pub async fn sync_upload_study(app: tauri::AppHandle, paths: Vec<String>) -> Result<Value, String> {
    let session = load(&app).ok_or("Sign in to RadLearn first.")?;
    let http = client()?;
    let options = AnonymizeOptions::default();
    let mut uids = UidMap::new();
    let total = paths.len();
    let mut sent = 0usize;
    let mut failed = 0usize;
    let mut last = Value::Null;
    for chunk in paths.chunks(BATCH) {
        let mut form = reqwest::multipart::Form::new();
        for (i, path) in chunk.iter().enumerate() {
            let bytes = anonymize_to_bytes(Path::new(path), &options, &mut uids)?;
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(format!("image-{}-{i}.dcm", sent))
                .mime_str("application/dicom")
                .map_err(|e| e.to_string())?;
            form = form.part("files", part);
        }
        let response = http
            .post(format!("{}/api/upload", session.server))
            .header("Origin", &session.server)
            .header(reqwest::header::COOKIE, &session.cookie)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Upload interrupted: {e}"))?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err("Your RadLearn session has expired or lacks author access. Sign in again.".into());
        }
        if !status.is_success() {
            let message = body.get("error").and_then(Value::as_str).unwrap_or("Upload failed.");
            return Err(format!("{message} (HTTP {status})"));
        }
        failed += body.get("failed").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
        sent += chunk.len();
        last = body;
        let _ = app.emit("upload-progress", UploadProgress { sent, total });
    }
    Ok(json!({ "sent": sent, "failed": failed, "server": session.server, "last": last }))
}
