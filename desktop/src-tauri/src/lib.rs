//! RadLearn Viewer — the Tauri shell.
//!
//! The shell's whole job (docs/DESKTOP_PLAN.md §2): native open dialogs,
//! walking folders / DICOMDIR / zip / discs, parsing headers fast, and handing
//! pixel bytes to the renderer over a custom protocol that can only serve files
//! the user opened. Everything visual is the renderer in `desktop/src`.
//!
//! Offline by construction: nothing in this crate opens a socket except the
//! updater (user-controlled, off-able) and the optional RadLearn sync
//! (sign-in required, off by default).

mod anonymize;
mod header;
mod scan;
mod sources;
mod store;
mod sync;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::http::{header as http_header, Response, StatusCode};
use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
use tauri::RunEvent;

use crate::scan::ScanResult;

/// Files the user opened this session. The `dicom://` protocol serves by index
/// into this list, so the renderer can never name an arbitrary path.
#[derive(Default)]
struct FileRegistry {
    paths: Vec<PathBuf>,
    by_path: std::collections::HashMap<PathBuf, u32>,
}

impl FileRegistry {
    fn register(&mut self, path: PathBuf) -> u32 {
        if let Some(id) = self.by_path.get(&path) {
            return *id;
        }
        let id = self.paths.len() as u32;
        self.paths.push(path.clone());
        self.by_path.insert(path, id);
        id
    }
}

#[derive(Default)]
struct AppState {
    registry: Arc<Mutex<FileRegistry>>,
    cancel: Arc<AtomicBool>,
    launch_paths: Mutex<Vec<String>>,
}

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_cache_dir().map_err(|e| e.to_string())
}

#[tauri::command]
async fn scan_sources(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<ScanResult, String> {
    let cache = cache_dir(&app)?;
    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::SeqCst);
    let registry = state.registry.clone();
    let emitter = app.clone();
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    tauri::async_runtime::spawn_blocking(move || {
        let batch_emitter = emitter.clone();
        let mut result = scan::scan(
            &paths,
            &cache,
            &cancel,
            &|progress| {
                let _ = emitter.emit("scan-progress", progress);
            },
            &|header| {
                header.file_id = registry.lock().register(PathBuf::from(&header.file_name));
            },
            &|batch| {
                let _ = batch_emitter.emit("scan-batch", batch);
            },
        )?;
        let mut reg = registry.lock();
        for header in result.headers.iter_mut() {
            header.file_id = reg.register(PathBuf::from(&header.file_name));
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_scan(state: tauri::State<'_, AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
async fn list_media() -> Vec<sources::MediaVolume> {
    tauri::async_runtime::spawn_blocking(sources::list_media)
        .await
        .unwrap_or_default()
}

/// Paths passed on the command line or by "Open with…" before the renderer
/// was listening. Drained once on startup.
#[tauri::command]
fn take_launch_paths(state: tauri::State<'_, AppState>) -> Vec<String> {
    std::mem::take(&mut *state.launch_paths.lock())
}

/// Write an export the renderer produced (PNG, JPEG, MP4, WebM). The bytes come
/// as a raw IPC body — a 40 MB video must not round-trip through JSON.
#[tauri::command]
fn write_export(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-export-path")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned())
        .ok_or("missing export path")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a binary body".into());
    };
    std::fs::write(&path, bytes).map_err(|e| format!("Could not write {path}: {e}"))
}

/// Total bytes held in the scan + archive caches, for the settings panel.
#[tauri::command]
fn cache_usage(app: tauri::AppHandle) -> Result<u64, String> {
    let dir = cache_dir(&app)?;
    Ok(walkdir::WalkDir::new(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum())
}

#[tauri::command]
fn clear_cache(app: tauri::AppHandle) -> Result<(), String> {
    let dir = cache_dir(&app)?;
    for sub in ["scan", "archives"] {
        let _ = std::fs::remove_dir_all(dir.join(sub));
    }
    Ok(())
}

/// Benchmark hook: `RADLEARN_BENCH=1` makes the renderer report its timings
/// here; they go to stdout as one JSON line, and the app exits when
/// `RADLEARN_BENCH_EXIT=1`. Used by `desktop/scripts/bench.mjs`.
#[tauri::command]
fn bench_report(app: tauri::AppHandle, report: serde_json::Value) {
    println!("RADLEARN_BENCH {}", report);
    if std::env::var("RADLEARN_BENCH_EXIT").as_deref() == Ok("1") {
        app.exit(0);
    }
}

static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Milliseconds since the process started — the renderer calls this at first
/// paint, which is the honest "cold start to usable window" number.
#[tauri::command]
fn startup_elapsed_ms() -> f64 {
    STARTED.get().map(|t| t.elapsed().as_secs_f64() * 1000.0).unwrap_or(0.0)
}

#[tauri::command]
fn bench_enabled() -> bool {
    std::env::var("RADLEARN_BENCH").as_deref() == Ok("1")
}

fn serve_file(registry: &Mutex<FileRegistry>, uri_path: &str) -> Response<Vec<u8>> {
    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(http_header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .unwrap()
    };
    // `/f/<id>` — anything else is refused.
    let id = uri_path
        .trim_start_matches('/')
        .strip_prefix("f/")
        .and_then(|rest| rest.split(['/', '?', '&']).next())
        .and_then(|s| s.parse::<u32>().ok());
    let Some(id) = id else { return not_found() };
    let path = registry.lock().paths.get(id as usize).cloned();
    let Some(path) = path else { return not_found() };
    match std::fs::read(&path) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(http_header::CONTENT_TYPE, "application/dicom")
            .header(http_header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(http_header::CACHE_CONTROL, "no-store")
            .body(bytes)
            .unwrap(),
        Err(_) => not_found(),
    }
}

fn launch_args() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter(|a| std::path::Path::new(a).exists())
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    STARTED.get_or_init(std::time::Instant::now);
    let state = AppState::default();
    *state.launch_paths.lock() = launch_args();
    let registry = state.registry.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .register_asynchronous_uri_scheme_protocol("dicom", move |_ctx, request, responder| {
            let registry = registry.clone();
            let path = request.uri().path().to_string();
            // Disc reads can take tens of ms; never block the webview thread.
            std::thread::spawn(move || responder.respond(serve_file(&registry, &path)));
        })
        .invoke_handler(tauri::generate_handler![
            scan_sources,
            cancel_scan,
            list_media,
            take_launch_paths,
            write_export,
            cache_usage,
            clear_cache,
            bench_report,
            bench_enabled,
            startup_elapsed_ms,
            store::history_list,
            store::history_record,
            store::history_remove,
            store::history_clear,
            store::settings_get,
            store::settings_set,
            anonymize::export_anonymized_dicom,
            sync::sync_status,
            sync::sync_sign_in,
            sync::sync_sign_out,
            sync::sync_upload_study,
        ])
        .build(tauri::generate_context!())
        .expect("error while building RadLearn Viewer");

    app.run(|_handle, _event| {
        // macOS delivers Finder "Open with…" and dock drops as an event, not argv.
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = _event {
            let handle = _handle;
            let paths: Vec<String> = urls
                .into_iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if !paths.is_empty() {
                if let Some(state) = handle.try_state::<AppState>() {
                    state.launch_paths.lock().extend(paths.clone());
                }
                let _ = handle.emit("open-paths", paths);
            }
        }
    });
}
