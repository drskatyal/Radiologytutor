//! FlowRad Viewer — the Tauri shell.
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
mod documents;
mod header;
mod image_store;
#[cfg(target_os = "macos")]
mod mac_mouse;
#[cfg(target_os = "macos")]
mod mac_webkit;
mod native;
mod native_view;
mod pacs;
mod pet;
mod preview;
mod procmem;
mod volume;
mod viewer_windows;
mod render3d;
mod scan;
mod sources;
mod store;
mod sync;
mod updates;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::http::{header as http_header, Response, StatusCode};
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri::Manager;
#[cfg(target_os = "macos")]
use tauri::Emitter;

use crate::scan::ScanResult;

/// mimalloc: decommits freed pages (purge) instead of keeping them committed
/// like the Windows process heap, so private bytes fall back after a study is
/// closed or a scan's per-thread buffers are dropped. Also faster for the
/// scan's many small header allocations.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Hand freed memory back to the OS now (study closed, scan finished):
/// mimalloc's free pages on every thread, then the process heap that the
/// system DLLs (D3D, WebView2 host) allocate from.
///
/// Every thread: mimalloc keeps a heap per thread, and a block freed by
/// another thread (the slice cache is cleared on the command thread, but the
/// slices were decoded on rayon workers) only goes back to its owner's heap,
/// which purges it on its own next allocation or collect. An idle worker
/// never does: the closed study's slices stayed committed (CI 0.8.2 close
/// gate: the app process kept +105 MB 30 s after close). So every worker
/// collects itself (the scan's pool is per scan; its threads exit with it).
pub(crate) fn release_memory() {
    rayon::broadcast(|_| unsafe { libmimalloc_sys::mi_collect(true) });
    unsafe {
        libmimalloc_sys::mi_collect(true);
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Memory::{GetProcessHeap, HeapCompact};
        HeapCompact(GetProcessHeap(), 0);
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        malloc_trim(0);
    }
}

/// Files the user opened this session. The `dicom://` protocol serves by index
/// into this list, so the renderer can never name an arbitrary path.
#[derive(Default)]
struct FileRegistry {
    paths: Vec<PathBuf>,
    by_path: std::collections::HashMap<PathBuf, u32>,
    /// Deflated Explicit VR LE files: served inflated (see `serve_file`).
    deflated: std::collections::HashSet<u32>,
}

const DEFLATED_EXPLICIT_LE: &str = "1.2.840.10008.1.2.1.99";

impl FileRegistry {
    fn register(&mut self, header: &header::Header) -> u32 {
        let path = PathBuf::from(&header.file_name);
        let id = match self.by_path.get(&path) {
            Some(id) => *id,
            None => {
                let id = self.paths.len() as u32;
                self.paths.push(path.clone());
                self.by_path.insert(path, id);
                id
            }
        };
        if header.transfer_syntax_uid.as_deref() == Some(DEFLATED_EXPLICIT_LE) {
            self.deflated.insert(id);
        }
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

/// Whether the native renderer draws this file (mirrors the page's
/// `nativeCapable`: monochrome, one frame per file).
fn native_draws(header: &header::Header) -> bool {
    let mono = header.photometric_interpretation.as_deref().map(|p| p.to_ascii_uppercase().starts_with("MONOCHROME")).unwrap_or(true);
    mono && header.number_of_frames.unwrap_or(1) <= 1
}

/// Scan a selection. Progress and header batches stream back over the two
/// channels the call carries (not app-wide events): no `listen` round trips
/// before the scan can start, and only the window that opened gets them.
#[tauri::command]
async fn scan_sources(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    native: tauri::State<'_, native::Shared>,
    paths: Vec<String>,
    on_progress: tauri::ipc::Channel<scan::ScanProgress>,
    on_batch: tauri::ipc::Channel<Vec<header::Header>>,
) -> Result<ScanResult, String> {
    let entered_at = startup_elapsed_ms();
    let cache = cache_dir(&app)?;
    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::SeqCst);
    let registry = state.registry.clone();
    let native = native::enabled().then(|| native.inner().clone());
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    tauri::async_runtime::spawn_blocking(move || {
        let first_batch_at = std::sync::OnceLock::<f64>::new();
        let mut result = scan::scan(
            &paths,
            &cache,
            &cancel,
            &|progress| {
                let _ = on_progress.send(progress);
            },
            &|header| {
                header.file_id = registry.lock().register(header);
            },
            &|batch| {
                let mut first = false;
                first_batch_at.get_or_init(|| {
                    first = true;
                    startup_elapsed_ms()
                });
                // The first batch is the file the page hangs first: decode it
                // now, while the page groups it and mounts the viewport, so
                // `native_cell_series` finds it in the store.
                if first {
                    if let (Some(native), Some(h)) = (&native, batch.first()) {
                        if native_draws(h) {
                            native.store().warm(vec![PathBuf::from(&h.file_name)]);
                        }
                    }
                }
                let _ = on_batch.send(batch);
            },
        )?;
        result.timings.entered_at_ms = Some(entered_at);
        result.timings.first_batch_at_ms = first_batch_at.get().copied();
        result.timings.done_at_ms = Some(startup_elapsed_ms());
        {
            let mut reg = registry.lock();
            for header in result.headers.iter_mut() {
                header.file_id = reg.register(header);
            }
        }
        if bench_on() {
            bench_scan_line(&result);
        }
        // A 4,000-file scan parses on every core; each thread keeps its
        // pages afterwards. Hand the slack back so an open study stays lean.
        release_memory();
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// SUV inputs for PET files (by protocol id), in the order asked.
#[tauri::command]
async fn pet_metadata(
    state: tauri::State<'_, AppState>,
    file_ids: Vec<u32>,
) -> Result<Vec<Option<pet::PetMeta>>, String> {
    let paths = paths_for(&state, &file_ids);
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| p.as_ref().and_then(|p| pet::read_pet(p)))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Absolute paths for protocol ids — what the anonymised export copies.
#[tauri::command]
fn paths_for_ids(state: tauri::State<'_, AppState>, file_ids: Vec<u32>) -> Vec<Option<String>> {
    paths_for(&state, &file_ids)
        .into_iter()
        .map(|p| p.map(|p| p.to_string_lossy().into_owned()))
        .collect()
}

fn paths_for(state: &AppState, ids: &[u32]) -> Vec<Option<PathBuf>> {
    let reg = state.registry.lock();
    ids.iter()
        .map(|id| reg.paths.get(*id as usize).cloned())
        .collect()
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
        .map(|v| {
            percent_encoding::percent_decode_str(v)
                .decode_utf8_lossy()
                .into_owned()
        })
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

#[cfg(all(target_os = "linux", target_env = "gnu"))]
extern "C" {
    fn malloc_trim(pad: usize) -> i32;
}

/// A `FLOWRAD_<name>` environment switch, falling back to the pre-rename
/// `RADLEARN_<name>` so older scripts and notes keep working.
pub(crate) fn flowrad_env(name: &str) -> Result<String, std::env::VarError> {
    std::env::var(format!("FLOWRAD_{name}")).or_else(|_| std::env::var(format!("RADLEARN_{name}")))
}

fn bench_on() -> bool {
    crate::flowrad_env("BENCH").as_deref() == Ok("1") || crate::flowrad_env("LEAK_ROUNDS").is_ok()
}

/// The release exe is a GUI-subsystem binary on Windows: its stdout goes
/// nowhere when it is started from a terminal, so `FLOWRAD_BENCH=1` printed
/// nothing on a real machine. When any bench/probe hook is on, attach to the
/// parent console (no-op when stdout is already redirected, e.g. bench.mjs).
fn attach_bench_console() {
    #[cfg(windows)]
    if bench_on() || crate::flowrad_env("PROBE_AFTER_MS").is_ok() {
        // SAFETY: plain Win32 call; failure (no parent console) is harmless.
        unsafe {
            windows_sys::Win32::System::Console::AttachConsole(
                windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
            );
        }
    }
}

/// Every bench line is also appended to a file, so a run started from
/// Explorer or a shortcut still leaves its numbers behind:
/// `FLOWRAD_BENCH_OUT` if set, else `flowrad-bench.jsonl` in the temp dir.
fn bench_emit(prefix: &str, value: &serde_json::Value) {
    let line = format!("{prefix} {value}");
    println!("{line}");
    let path = crate::flowrad_env("BENCH_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("flowrad-bench.jsonl"));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = writeln!(f, "{line}");
    }
}

/// The last scan's numbers, for the watchdog line.
static LAST_SCAN: Mutex<Option<serde_json::Value>> = parking_lot::const_mutex(None);

/// Printed by the shell the moment a scan ends — independent of the webview,
/// so a locked, minimised or throttled window still yields scan timings.
fn bench_scan_line(result: &ScanResult) {
    let series: std::collections::HashSet<&str> = result
        .headers
        .iter()
        .filter_map(|h| h.series_instance_uid.as_deref())
        .collect();
    let studies: std::collections::HashSet<&str> = result
        .headers
        .iter()
        .filter_map(|h| h.study_instance_uid.as_deref())
        .collect();
    let line = serde_json::json!({
        "files": result.inspected,
        "images": result.headers.len(),
        "skipped": result.skipped,
        "studies": studies.len(),
        "series": series.len(),
        "cacheHits": result.cache_hits,
        "usedDicomdir": result.used_dicomdir,
        "warnings": result.warnings.len(),
        "rust": result.timings,
        "processUptimeMs": startup_elapsed_ms(),
    });
    bench_emit("FLOWRAD_BENCH_SCAN", &line);
    *LAST_SCAN.lock() = Some(line);
}

/// `FLOWRAD_BENCH_EXIT=1` must never leave a benchmark hanging: if the
/// renderer has not reported by `FLOWRAD_BENCH_TIMEOUT_MS` (default 120 s),
/// print what the shell knows and exit with status 3.
fn start_bench_watchdog() {
    if !bench_on() || crate::flowrad_env("BENCH_EXIT").as_deref() != Ok("1") {
        return;
    }
    let ms = crate::flowrad_env("BENCH_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120_000u64);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms));
        let line = serde_json::json!({
            "timedOut": true,
            "afterMs": ms,
            "scan": LAST_SCAN.lock().clone(),
            "note": "the renderer never reported; scan numbers (if any) come from the shell",
        });
        bench_emit("FLOWRAD_BENCH", &line);
        std::process::exit(3);
    });
}

/// End-to-end paint probe (`FLOWRAD_PROBE_AFTER_MS=8000`): on an otherwise
/// NORMAL launch (no bench hooks), the renderer samples every viewport's
/// on-screen pixels after that long and reports them here; used by
/// `desktop/scripts/e2e-paint.py` to assert the main viewport is not blank.
#[tauri::command]
fn probe_after_ms() -> Option<u64> {
    crate::flowrad_env("PROBE_AFTER_MS")
        .ok()
        .and_then(|v| v.parse().ok())
}

#[tauri::command]
fn probe_report(app: tauri::AppHandle, report: serde_json::Value) {
    bench_emit("FLOWRAD_PROBE", &report);
    app.exit(0);
}

/// How long the renderer waits for a first frame before reporting without
/// one (`FLOWRAD_BENCH_PAINT_TIMEOUT_MS`, default 20 s).
#[tauri::command]
fn bench_paint_timeout_ms() -> u64 {
    crate::flowrad_env("BENCH_PAINT_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20_000)
}

/// Idle footprint. `low = true` while nothing is open: on Windows this sets
/// WebView2's MemoryUsageTargetLevel to Low, which trims the renderer's
/// working set and drops caches; Normal again as soon as a study opens.
/// Other platforms have no equivalent knob; it is a no-op there.
///
/// `trim = true` (the viewer idle with a study open): our own share too. The
/// native renderer's decoded-slice cache keeps only its most recently used
/// `IDLE_STORE_KEEP_MB` (the slices around the one on screen) and the
/// allocator gives the rest back; the cache refills from the next scroll.
#[tauri::command]
fn set_memory_mode(window: tauri::WebviewWindow, low: bool, trim: Option<bool>, native: tauri::State<'_, native::Shared>) {
    // The cache serves the main window's native viewports: only its idle trims it.
    if low && trim == Some(true) && window.label() == "main" {
        if let Some(store) = native.store.get() {
            if store.trim_to(IDLE_STORE_KEEP_MB << 20) > 0 {
                release_memory();
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = window.with_webview(move |webview| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
            };
            use windows::core::Interface;
            if let Ok(core) = webview.controller().CoreWebView2() {
                if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                    let level = if low {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                    } else {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                    };
                    let _ = core19.SetMemoryUsageTargetLevel(level);
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (window, low);
}

/// Benchmark hook: `FLOWRAD_BENCH=1` makes the renderer report its timings
/// here; they go to stdout as one JSON line, and the app exits when
/// `FLOWRAD_BENCH_EXIT=1`. Used by `desktop/scripts/bench.mjs`.
#[tauri::command]
fn bench_report(app: tauri::AppHandle, report: serde_json::Value) {
    bench_emit("FLOWRAD_BENCH", &report);
    if crate::flowrad_env("BENCH_EXIT").as_deref() == Ok("1") {
        app.exit(0);
    }
}

static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// What the decoded-slice cache keeps while the viewer is idle (MB): about
/// 32 CT slices of 512 x 512, the neighbourhood of the slice on screen.
const IDLE_STORE_KEEP_MB: usize = 16;

/// Startup marks (ms since process start), for the cold-start breakdown:
/// window built (Tauri `build()` returned: window + WebView2 requested), page
/// navigation started and finished (the webview actually loading the page).
static MARKS: parking_lot::Mutex<[Option<f64>; 3]> = parking_lot::Mutex::new([None; 3]);

fn mark(i: usize) {
    if let Some(t) = STARTED.get() {
        let mut m = MARKS.lock();
        if m[i].is_none() {
            m[i] = Some(t.elapsed().as_secs_f64() * 1000.0);
        }
    }
}

/// Native mode: when Rust first presented a frame in the window (before
/// WebView2 has loaded the page), ms since process start.
static NATIVE_FIRST_PAINT: std::sync::OnceLock<f64> = std::sync::OnceLock::new();

#[tauri::command]
fn startup_marks() -> serde_json::Value {
    let m = *MARKS.lock();
    serde_json::json!({
        "windowBuiltMs": m[0],
        "navStartMs": m[1],
        "navDoneMs": m[2],
        "nativeFirstPaintMs": NATIVE_FIRST_PAINT.get(),
        "gpuWarmMs": native::WARM_MS.get(),
    })
}

/// Milliseconds since the process started — the renderer calls this at first
/// paint, which is the honest "cold start to usable window" number.
#[tauri::command]
fn startup_elapsed_ms() -> f64 {
    STARTED
        .get()
        .map(|t| t.elapsed().as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// `FLOWRAD_BENCH_VIEW=mpr|3d|fusion`: switch to that view once the study is open.
#[tauri::command]
fn bench_view() -> Option<String> {
    // FLOWRAD_LEAK_ROUNDS alone used to do nothing (it only sized a leak run
    // that BENCH_VIEW=leak had to request); asking for rounds now asks for it.
    crate::flowrad_env("BENCH_VIEW")
        .ok()
        .or_else(|| crate::flowrad_env("LEAK_ROUNDS").ok().map(|_| "leak".to_string()))
}

/// `FLOWRAD_BENCH_VIEW=close`: how long the study stays open (settled
/// sample) before the app closes it (`FLOWRAD_BENCH_CLOSE_AFTER_MS`, default 20 s).
#[tauri::command]
fn bench_close_after_ms() -> u64 {
    crate::flowrad_env("BENCH_CLOSE_AFTER_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000)
}

/// `FLOWRAD_BENCH_PIXELS=1`: include decoded-pixel statistics of the first
/// image in the bench report, so a script can check every codec against an
/// independent decoder (`desktop/scripts/codec-check.py`).
#[tauri::command]
fn bench_pixels() -> bool {
    crate::flowrad_env("BENCH_PIXELS").as_deref() == Ok("1")
}

/// Voice e2e (bench only: `FLOWRAD_BENCH=1 FLOWRAD_BENCH_VIEW=voice`): the
/// spoken test phrases at `FLOWRAD_BENCH_VOICE_WAV`, fed to the recognizer
/// through its test hook. Empty when not benchmarking or unset.
#[tauri::command]
fn bench_voice_wav() -> tauri::ipc::Response {
    let bytes = if crate::flowrad_env("BENCH").as_deref() == Ok("1") {
        crate::flowrad_env("BENCH_VOICE_WAV").ok().and_then(|p| std::fs::read(p).ok()).unwrap_or_default()
    } else {
        Vec::new()
    };
    tauri::ipc::Response::new(bytes)
}

/// Whole process-tree memory (debug HUD, leak test).
#[tauri::command]
async fn process_memory() -> procmem::TreeMem {
    tauri::async_runtime::spawn_blocking(procmem::current_tree).await.unwrap_or(procmem::TreeMem { total_mb: 0, processes: vec![] })
}

// ───────────── Phase 2 native renderer (native.rs, FLOWRAD_NATIVE=1) ─────────────

#[tauri::command]
fn native_status(window: tauri::WebviewWindow, native: tauri::State<'_, native::Shared>) -> native::NativeStatus {
    let mut s = native.status();
    // Viewer windows on other monitors never build the GPU (JS renderer):
    // nothing for them to wait for.
    s.lazy &= window.label() == "main";
    s
}

/// Create the GPU surface under the page and make the webview transparent.
#[tauri::command]
async fn native_init(window: tauri::WebviewWindow, native: tauri::State<'_, native::Shared>) -> Result<native::NativeStatus, String> {
    if !native::enabled() {
        return Ok(native.status());
    }
    // One native surface, on the main window. Viewer windows on other
    // monitors keep the JS renderer (their own surfaces are a follow-up).
    if window.label() != "main" {
        return Ok(native::NativeStatus { enabled: false, ..Default::default() });
    }
    Ok(init_native(&window, native.inner()).await)
}

/// Build the GPU on the main window (idempotent) and put it under the page.
async fn init_native(window: &tauri::WebviewWindow, native: &native::Shared) -> native::NativeStatus {
    let was_ready = native.has_gpu();
    let status = native.init(window).await;
    if status.ready {
        let scale = window.scale_factor().unwrap_or(1.0);
        let origin = window.inner_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
        native.set_window_facts(origin, scale);
    }
    if status.ready && !was_ready {
        if native::lazy_gpu() {
            // Built on demand, with the page already up: present a frame (the
            // canvas colour) before the webview turns transparent, so the page
            // never sits over a swap chain that has shown nothing yet.
            let _ = native.render(window.scale_factor().unwrap_or(1.0));
            start_gpu_release_watch(native.clone(), window.clone());
        }
        // Where the page draws nothing, the native surface shows through.
        let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    }
    native.status()
}

/// Lazy GPU: a native call that draws found the GPU released (study closed,
/// then a new one opened): rebuild it first. One check when it is there.
async fn ensure_native(window: &tauri::WebviewWindow, native: &native::Shared) {
    if window.label() == "main" && native.needs_gpu() {
        init_native(window, native).await;
    }
}

/// Lazy GPU: watch for the GPU going unused (no viewport, nothing drawn for
/// `GPU_IDLE_RELEASE`) and release it then, so a closed study (or an Open
/// dialog that was cancelled) leaves the app at its empty footprint. One
/// watcher at a time; it ends with the release.
fn start_gpu_release_watch(native: native::Shared, window: tauri::WebviewWindow) {
    static WATCHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if WATCHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new().name("flowrad-gpu-idle".into()).spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if !native.has_gpu() {
                break;
            }
            if native.release_gpu_if_idle(native::GPU_IDLE_RELEASE) {
                // Nothing under the page now: the webview paints its own
                // opaque canvas colour again (as before the first study).
                let _ = window.set_background_color(Some(tauri::window::Color(0x0B, 0x0D, 0x10, 0xFF)));
                let before = commit_mb();
                release_memory();
                if bench_on() {
                    bench_emit(
                        "FLOWRAD_BENCH_CLOSE",
                        &serde_json::json!({ "step": "gpu released", "idleS": native::GPU_IDLE_RELEASE.as_secs(), "commitMb": { "beforeRelease": before, "after": commit_mb() } }),
                    );
                }
                break;
            }
        }
        WATCHING.store(false, std::sync::atomic::Ordering::SeqCst);
    });
    if spawned.is_err() {
        WATCHING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The page's viewport rectangles (CSS px); draws a frame. Returns its CPU ms.
#[tauri::command]
async fn native_set_cells(window: tauri::WebviewWindow, cells: Vec<native::Cell>, native: tauri::State<'_, native::Shared>) -> Result<f64, String> {
    ensure_native(&window, native.inner()).await;
    native.set_cells(cells);
    let scale = window.scale_factor().unwrap_or(1.0);
    if let Ok(size) = window.inner_size() {
        native.resize(size.width, size.height);
    }
    if let Ok(p) = window.inner_position() {
        native.set_window_facts((p.x, p.y), scale);
    }
    native.render(scale)
}

/// Window / level of the test image (stored units); draws a frame.
#[tauri::command]
async fn native_set_wl(window: tauri::WebviewWindow, center: f32, width: f32, native: tauri::State<'_, native::Shared>) -> Result<f64, String> {
    native.set_wl(center, width);
    native.render(window.scale_factor().unwrap_or(1.0))
}

/// P2.1: open the study given on the command line natively (its largest
/// series), decode + draw the first slice. Times from the call and from
/// process start, so the bench has a native "first image".
#[tauri::command]
async fn native_open_launch_study(window: tauri::WebviewWindow, native: tauri::State<'_, native::Shared>) -> Result<serde_json::Value, String> {
    let started = std::time::Instant::now();
    let roots: Vec<PathBuf> = launch_args().into_iter().map(PathBuf::from).collect();
    if roots.is_empty() {
        return Err("no study on the command line".into());
    }
    let series = tauri::async_runtime::spawn_blocking(move || native::largest_series(&roots)).await.map_err(|e| e.to_string())?;
    if series.is_empty() {
        return Err("no DICOM images found".into());
    }
    let listed_ms = started.elapsed().as_secs_f64() * 1000.0;
    ensure_native(&window, native.inner()).await;
    let shown = native.open_series(series, window.scale_factor().unwrap_or(1.0))?;
    Ok(serde_json::json!({
        "listMs": listed_ms,
        "firstImageMs": started.elapsed().as_secs_f64() * 1000.0,
        "firstImageSinceStartMs": startup_elapsed_ms(),
        "first": shown,
    }))
}

/// P2.1: scroll the native series by `delta` slices.
#[tauri::command]
async fn native_scroll(window: tauri::WebviewWindow, delta: i64, native: tauri::State<'_, native::Shared>) -> Result<native::ShowResult, String> {
    native.scroll_spike(delta, window.scale_factor().unwrap_or(1.0))
}

/// Study open: decode the slices the first viewport is about to ask for
/// while React mounts it, so `native_cell_series` finds them decoded.
#[tauri::command]
fn native_warm(file_ids: Vec<u32>, state: tauri::State<'_, AppState>, native: tauri::State<'_, native::Shared>) {
    if !native::enabled() {
        return;
    }
    let paths: Vec<PathBuf> = paths_for(&state, &file_ids).into_iter().flatten().collect();
    native.store().warm(paths);
}

/// P2.1: close the native series: texture and decoded slices freed.
#[tauri::command]
fn native_close(_window: tauri::WebviewWindow, native: tauri::State<'_, native::Shared>) {
    // Study closed: every viewport, decoded slice and GPU texture, then the
    // allocator's slack (reformat volumes are freed by their views' unmount,
    // volume_close). Back to the empty-app footprint (bench `close` gate:
    // within 30 MB of baseline).
    let before = commit_mb();
    let held = native.close_all();
    let after_clear = commit_mb();
    release_memory();
    let after_release = commit_mb();
    // Calls already in flight when the study closed (a viewport's last
    // view / scroll, the prefetch behind it) land after the clear and put
    // slices back (CI: 26 slices, 13 MB, after close). Once they have
    // drained, and if no viewport exists by then (nothing open, so the cache
    // serves nobody), empty the cache again and collect.
    // macOS: WebKit keeps the study's decoded thumbnails / previews in its
    // memory cache after the page lets go (WebView2 does not): empty it now
    // and again after the late sweep (requests in flight at the close).
    #[cfg(target_os = "macos")]
    mac_webkit::drop_memory_cache(&_window);
    let native = native.inner().clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let swept = native.sweep_if_idle();
        #[cfg(target_os = "macos")]
        if swept.is_some() {
            mac_webkit::drop_memory_cache(&_window);
        }
        release_memory();
        if bench_on() {
            bench_emit(
                "FLOWRAD_BENCH_CLOSE",
                &serde_json::json!({ "step": "late sweep", "swept": swept, "store": native.store().stats(), "commitMb": commit_mb(), "heapCommittedMb": heap_committed_mb() }),
            );
        }
    });
    if bench_on() {
        bench_emit(
            "FLOWRAD_BENCH_CLOSE",
            &serde_json::json!({
                "held": held,
                "commitMb": { "before": before, "afterClear": after_clear, "afterRelease": after_release },
                "heapCommittedMb": heap_committed_mb(),
            }),
        );
    }
}

extern "C" {
    // mimalloc-stats.h (v3): the allocator's statistics as JSON; the result is
    // mi_malloc'ed when `buf` is null.
    fn mi_stats_get_json(buf_size: usize, buf: *mut std::ffi::c_char) -> *mut std::ffi::c_char;
}

/// What mimalloc itself has committed, MB (the Rust heap's share of the
/// process's private bytes; the rest is D3D / WARP, DLLs, stacks).
pub(crate) fn heap_committed_mb() -> Option<f64> {
    let json = unsafe {
        let p = mi_stats_get_json(0, std::ptr::null_mut());
        if p.is_null() {
            return None;
        }
        let s = std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned();
        libmimalloc_sys::mi_free(p.cast());
        s
    };
    let v: serde_json::Value = serde_json::from_str(&json).ok()?;
    let current = v.get("committed")?.get("current")?.as_f64()?;
    Some((current / 1_048_576.0 * 10.0).round() / 10.0)
}

/// mimalloc option `purge_delay` (v3 `mi_option_e` index 15): ms before
/// freed memory is decommitted. 0 = at once, on every thread, without
/// waiting for a collect that an idle thread never runs.
const MI_OPTION_PURGE_DELAY: libmimalloc_sys::mi_option_t = 15;

/// mimalloc option `purge_decommits` (v3 `mi_option_e` index 5, default 1):
/// a purge decommits instead of resetting.
const MI_OPTION_PURGE_DECOMMITS: libmimalloc_sys::mi_option_t = 5;

/// This process's committed memory (private bytes), MB, from the allocator's
/// view of the OS counters. macOS: the physical footprint instead (what
/// Activity Monitor and the bench report): mimalloc decommits there with
/// MADV_FREE_REUSABLE, which leaves the pages in the resident size its
/// counter reads but takes them out of the footprint at once.
pub(crate) fn commit_mb() -> f64 {
    #[cfg(target_os = "macos")]
    if let Some(mb) = footprint_mb() {
        return mb;
    }
    let (mut z, mut commit) = (0usize, 0usize);
    let (mut a, mut b, mut c, mut d, mut e, mut f) = (0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
    unsafe {
        libmimalloc_sys::mi_process_info(&mut z, &mut a, &mut b, &mut c, &mut d, &mut commit, &mut e, &mut f);
    }
    (commit as f64 / 1_048_576.0 * 10.0).round() / 10.0
}

/// macOS: this process's physical footprint, MB (`ri_phys_footprint`, the
/// "Memory" column of Activity Monitor; the bench gates on the same number).
#[cfg(target_os = "macos")]
pub(crate) fn footprint_mb() -> Option<f64> {
    let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a rusage_info_v2, the flavour asked for.
    let rc = unsafe { libc::proc_pid_rusage(libc::getpid(), libc::RUSAGE_INFO_V2, &mut info as *mut libc::rusage_info_v2 as *mut libc::rusage_info_t) };
    (rc == 0).then(|| (info.ri_phys_footprint as f64 / 1_048_576.0 * 10.0).round() / 10.0)
}

// ───────────── P2.2: native viewports in the app (one per layout cell) ─────────────

/// Every layout cell's rectangle (CSS px); cells not listed are freed. Draws.
#[tauri::command]
async fn native_layout(window: tauri::WebviewWindow, cells: Vec<native::CellRect>, native: tauri::State<'_, native::Shared>) -> Result<f64, String> {
    // No viewport (study closed) and no GPU (released): nothing to draw, and
    // an empty layout must not rebuild it.
    if cells.is_empty() && !native.has_gpu() {
        native.set_layout(cells);
        return Ok(0.0);
    }
    ensure_native(&window, native.inner()).await;
    native.set_layout(cells);
    if let Ok(size) = window.inner_size() {
        native.resize(size.width, size.height);
    }
    native.render(window.scale_factor().unwrap_or(1.0))
}

/// Show a series (the app's file ids, display order) in a cell.
#[tauri::command]
async fn native_cell_series(
    window: tauri::WebviewWindow,
    id: String,
    file_ids: Vec<u32>,
    index: usize,
    rect: Option<native::Cell>,
    state: tauri::State<'_, AppState>,
    native: tauri::State<'_, native::Shared>,
) -> Result<native::ShowResult, String> {
    // Only files the user opened (the registry), like the dicom:// protocol.
    let paths: Vec<PathBuf> = paths_for(&state, &file_ids).into_iter().collect::<Option<Vec<_>>>().ok_or("unknown file id")?;
    ensure_native(&window, native.inner()).await;
    let scale = window.scale_factor().unwrap_or(1.0);
    // A new viewport's frame lands in its own rect: the page sends it with
    // the series, so the first image does not wait for the next `native_layout`.
    if rect.is_some() {
        if let Ok(size) = window.inner_size() {
            native.resize(size.width, size.height);
        }
    }
    tauri::async_runtime::spawn_blocking({
        let native = native.inner().clone();
        move || native.set_series(&id, paths, index, rect, scale)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A streaming series grew: append only the new files to the cell's list.
/// `None`: the cell no longer matches (`from` is stale); re-send the series.
#[tauri::command]
fn native_cell_series_append(
    id: String,
    from: usize,
    file_ids: Vec<u32>,
    state: tauri::State<'_, AppState>,
    native: tauri::State<'_, native::Shared>,
) -> Result<Option<usize>, String> {
    let paths: Vec<PathBuf> = paths_for(&state, &file_ids).into_iter().collect::<Option<Vec<_>>>().ok_or("unknown file id")?;
    Ok(native.append_series(&id, from, paths))
}

/// Change a cell's view: slice, window/level, zoom, pan, rotation, flip, invert.
#[tauri::command]
async fn native_cell_view(
    window: tauri::WebviewWindow,
    id: String,
    patch: native_view::ViewPatch,
    native: tauri::State<'_, native::Shared>,
) -> Result<native::ShowResult, String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let native = native.inner().clone();
    tauri::async_runtime::spawn_blocking(move || native.update_view(&id, patch, scale)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn native_cell_scroll(window: tauri::WebviewWindow, id: String, delta: i64, native: tauri::State<'_, native::Shared>) -> Result<native::ShowResult, String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let native = native.inner().clone();
    tauri::async_runtime::spawn_blocking(move || native.scroll(&id, delta, scale)).await.map_err(|e| e.to_string())?
}

/// P2.4: a plane / slab of the built Rust volume in a native cell.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn native_cell_plane(
    window: tauri::WebviewWindow,
    id: String,
    key: String,
    plane: String,
    index: usize,
    slab: Option<String>,
    mm: Option<f64>,
    max_dim: Option<usize>,
    wl: Option<(f32, f32)>,
    native: tauri::State<'_, native::Shared>,
) -> Result<native::ShowResult, String> {
    let key: u64 = key.parse().map_err(|_| "bad volume key")?;
    let plane = volume::Plane::parse(&plane).ok_or("bad plane")?;
    let slab = slab.as_deref().and_then(volume::Slab::parse).unwrap_or(volume::Slab::Off);
    ensure_native(&window, native.inner()).await;
    let scale = window.scale_factor().unwrap_or(1.0);
    let native = native.inner().clone();
    tauri::async_runtime::spawn_blocking(move || native.set_plane(&id, key, plane, index, slab, mm.unwrap_or(0.0), max_dim.unwrap_or(1024), wl, scale))
        .await
        .map_err(|e| e.to_string())?
}

/// P2.5: a 3D frame of the built Rust volume into a native cell.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn native_cell_render3d(
    window: tauri::WebviewWindow,
    id: String,
    key: String,
    mode: String,
    yaw: f32,
    pitch: f32,
    zoom: f32,
    center: f32,
    width: f32,
    size: usize,
    fast: bool,
    native: tauri::State<'_, native::Shared>,
) -> Result<native::Render3dResult, String> {
    let key: u64 = key.parse().map_err(|_| "bad volume key")?;
    let mode = render3d::Mode::parse(&mode).ok_or("bad 3D mode")?;
    ensure_native(&window, native.inner()).await;
    let scale = window.scale_factor().unwrap_or(1.0);
    let native = native.inner().clone();
    tauri::async_runtime::spawn_blocking(move || native.show_render3d(&id, key, mode, yaw, pitch, zoom, center, width, size, fast, scale))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn native_cell_close(id: String, native: tauri::State<'_, native::Shared>) {
    native.close_cell(&id);
}

/// P2.3: ROI statistics on a cell's current slice (image px coordinates).
#[tauri::command]
fn native_roi_stats(id: String, shape: native::RoiShape, native: tauri::State<'_, native::Shared>) -> Option<native::RoiStats> {
    native.roi_stats(&id, &shape)
}

/// The image pixel and its value under a cell point (CSS px), or null.
#[tauri::command]
fn native_pick(id: String, x: f32, y: f32, native: tauri::State<'_, native::Shared>) -> Option<serde_json::Value> {
    native.pick(&id, x, y).map(|(col, row, value)| serde_json::json!({ "col": col, "row": row, "value": value }))
}

#[tauri::command]
fn native_store_stats(native: tauri::State<'_, native::Shared>) -> image_store::StoreStats {
    native.store().stats()
}

/// Test hook: FLOWRAD_SIMULATE_BLANK_GPU=1 makes the paint check read the GPU
/// path as black, to exercise the CPU fallback on any machine.
#[tauri::command]
fn simulate_blank_gpu() -> bool {
    crate::flowrad_env("SIMULATE_BLANK_GPU").as_deref() == Ok("1")
}

/// FLOWRAD_LEAK_ROUNDS=N: how many times the headless leak test opens and
/// closes MPR / 3D and the other features (default 2).
#[tauri::command]
fn bench_leak_rounds() -> u32 {
    crate::flowrad_env("LEAK_ROUNDS").ok().and_then(|v| v.parse().ok()).unwrap_or(2).clamp(1, 50)
}

/// FLOWRAD_BENCH_SLAB=mip:20 (mode:mm): volume views open with that slab.
#[tauri::command]
fn bench_slab() -> Option<String> {
    crate::flowrad_env("BENCH_SLAB").ok()
}

/// FLOWRAD_BENCH_REFORMAT=coronal|sagittal|axial: the bench opens a quick
/// reformat in the first viewport instead of the stack.
#[tauri::command]
fn bench_reformat() -> Option<String> {
    crate::flowrad_env("BENCH_REFORMAT").ok()
}

/// FLOWRAD_DEBUG=1: show the memory HUD from launch.
#[tauri::command]
fn debug_enabled() -> bool {
    crate::flowrad_env("DEBUG").as_deref() == Ok("1")
}

#[tauri::command]
fn bench_enabled() -> bool {
    bench_on()
}

/// `/p/<id>`: instant-preview PNG of a registered file (see preview.rs).
fn serve_preview(registry: &Mutex<FileRegistry>, id: &str) -> Response<Vec<u8>> {
    // `<id>` full size, `<id>/<maxDim>` a thumbnail.
    let mut parts = id.split('/');
    let path = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .and_then(|id| registry.lock().paths.get(id as usize).cloned());
    let max_dim = parts.next().and_then(|s| s.parse::<usize>().ok()).map(|m| m.clamp(16, 1024));
    match path.and_then(|p| preview::render_png_sized(&p, max_dim)) {
        Some(png) => Response::builder()
            .status(StatusCode::OK)
            .header(http_header::CONTENT_TYPE, "image/png")
            .header(http_header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(http_header::CACHE_CONTROL, "no-store")
            .body(png)
            .unwrap(),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(http_header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .unwrap(),
    }
}

/// `/v/<key>/<plane>/<index>/<center>/<width>/<maxDim>`: one rendered plane
/// of the native volume (volume.rs).
fn serve_volume_plane(rest: &str) -> Response<Vec<u8>> {
    serve_png(volume::serve(rest))
}

fn serve_png(png: Option<Vec<u8>>) -> Response<Vec<u8>> {
    match png {
        Some(png) => Response::builder()
            .status(StatusCode::OK)
            .header(http_header::CONTENT_TYPE, "image/png")
            .header(http_header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(http_header::CACHE_CONTROL, "no-store")
            .body(png)
            .unwrap(),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(http_header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .unwrap(),
    }
}

/// Build the native volume of a series (file ids in any order) in Rust.
#[tauri::command]
async fn volume_build(state: tauri::State<'_, AppState>, file_ids: Vec<u32>) -> Result<volume::VolumeInfo, String> {
    let paths: Vec<PathBuf> = paths_for(&state, &file_ids).into_iter().flatten().collect();
    tauri::async_runtime::spawn_blocking(move || volume::build(paths))
        .await
        .map_err(|e| e.to_string())?
}

/// Which native mouse inputs the page wants forwarded (macOS: side buttons
/// WKWebView reports as "middle", and notched tilt). A no-op elsewhere, where
/// the webview delivers them itself.
#[tauri::command]
fn native_mouse_wanted(buttons: bool, tilt: bool) {
    #[cfg(target_os = "macos")]
    mac_mouse::set_wanted(buttons, tilt);
    #[cfg(not(target_os = "macos"))]
    let _ = (buttons, tilt);
}

/// A view of the native volume closed; freed when no view uses it.
#[tauri::command]
fn volume_close(key: String) {
    if let Ok(k) = key.parse::<u64>() {
        volume::release(k);
        if volume::current(k).is_none() {
            render3d::release(k);
        }
    }
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
    let (path, deflated) = {
        let reg = registry.lock();
        (
            reg.paths.get(id as usize).cloned(),
            reg.deflated.contains(&id),
        )
    };
    let Some(path) = path else { return not_found() };
    let bytes = if deflated {
        inflate_to_explicit_le(&path)
    } else {
        std::fs::read(&path).map_err(|e| e.to_string())
    };
    match bytes {
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

/// Cornerstone's loader cannot read Deflated Explicit VR LE, so those files
/// are re-encoded as plain Explicit VR LE on the way out. Rare in practice
/// (some ultrasound and SR exports), and per-file, so the cost is local.
fn inflate_to_explicit_le(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let mut obj = dicom_object::open_file(path).map_err(|e| e.to_string())?;
    obj.update_meta(|meta| meta.transfer_syntax = "1.2.840.10008.1.2.1\0".to_string());
    let mut out = Vec::new();
    obj.write_all(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// The app's context. `FLOWRAD_WEBVIEW2_EXTRA_ARGS` appends WebView2 browser
/// arguments to the configured ones (A/B runs of process-model and memory
/// flags; every window takes the main window's, see viewer_windows.rs).
/// WebView2's own WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS did not reach the
/// browser in CI (the A/B's process count never changed), this does.
fn context() -> tauri::Context<tauri::Wry> {
    let mut context = tauri::generate_context!();
    if let Ok(extra) = flowrad_env("WEBVIEW2_EXTRA_ARGS") {
        if let Some(w) = context.config_mut().app.windows.first_mut() {
            let base = w.additional_browser_args.take().unwrap_or_default();
            w.additional_browser_args = Some(format!("{base} {extra}").trim().to_string());
        }
    }
    context
}

/// WebView2 features an offline viewer never uses, off for the session:
/// form autofill and password saving (their managers and stores live in the
/// browser process), SmartScreen reputation checks (also off by flag), the
/// URL status bubble, swipe navigation, and tracking prevention (it loads
/// and matches a block list on every request; only local content loads).
#[cfg(windows)]
fn trim_webview2(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Profile3, ICoreWebView2Settings4, ICoreWebView2Settings6, ICoreWebView2Settings8, ICoreWebView2_13,
            COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE,
        };
        use windows::core::Interface;
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        if let Ok(settings) = core.Settings() {
            let _ = settings.SetIsStatusBarEnabled(false);
            if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
                let _ = s4.SetIsGeneralAutofillEnabled(false);
                let _ = s4.SetIsPasswordAutosaveEnabled(false);
            }
            if let Ok(s6) = settings.cast::<ICoreWebView2Settings6>() {
                let _ = s6.SetIsSwipeNavigationEnabled(false);
            }
            if let Ok(s8) = settings.cast::<ICoreWebView2Settings8>() {
                let _ = s8.SetIsReputationCheckingRequired(false);
            }
        }
        if let Ok(profile) = core.cast::<ICoreWebView2_13>().and_then(|c| c.Profile()) {
            if let Ok(p3) = profile.cast::<ICoreWebView2Profile3>() {
                let _ = p3.SetPreferredTrackingPreventionLevel(COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE);
            }
        }
    });
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
    // Freed memory goes back to the OS at once (see MI_OPTION_PURGE_DELAY),
    // and a purge decommits (MADV_FREE_REUSABLE on macOS, out of the
    // footprint at once) rather than resets (MADV_FREE: counted until the
    // system is short of memory).
    unsafe {
        libmimalloc_sys::mi_option_set(MI_OPTION_PURGE_DELAY, 0);
        libmimalloc_sys::mi_option_set(MI_OPTION_PURGE_DECOMMITS, 1);
    }
    // The GPU device and pipelines build on their own thread from here, in
    // parallel with WebView2 starting (native.rs `prewarm`), when a study is
    // about to need them: always on macOS / Linux, and on Windows when one is
    // on the command line (it opens at once, its first image waits on the
    // GPU). Started empty, Windows builds them when a study is about to open
    // (native.rs `lazy_gpu`): the empty app holds no device.
    let launch_paths = launch_args();
    let gpu_at_launch = native::enabled() && (!native::lazy_gpu() || !launch_paths.is_empty());
    if gpu_at_launch {
        native::prewarm();
    }
    attach_bench_console();
    let state = AppState::default();
    *state.launch_paths.lock() = launch_paths;
    start_bench_watchdog();
    let registry = state.registry.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .manage(viewer_windows::WindowHandoff::default())
        .manage(native::Shared::default())
        .manage(updates::Staged::default())
        // Closing the main window ends the session: viewer windows on other
        // monitors go with it (their webviews and memory with them).
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    window.app_handle().exit(0);
                }
                // Native surface follows the window (no-op until it exists).
                if let tauri::WindowEvent::Resized(size) = event {
                    if let Some(native) = window.app_handle().try_state::<native::Shared>() {
                        native.resize(size.width, size.height);
                        let _ = native.render(window.scale_factor().unwrap_or(1.0));
                    }
                }
            }
        })
        .on_page_load(|_webview, payload| match payload.event() {
            tauri::webview::PageLoadEvent::Started => mark(1),
            tauri::webview::PageLoadEvent::Finished => mark(2),
        })
        .register_asynchronous_uri_scheme_protocol("dicom", move |_ctx, request, responder| {
            let registry = registry.clone();
            let path = request.uri().path().to_string();
            // Disc reads can take tens of ms; never block the webview thread.
            std::thread::spawn(move || {
                let trimmed = path.trim_start_matches('/');
                let response = if let Some(id) = trimmed.strip_prefix("p/") {
                    serve_preview(&registry, id)
                } else if let Some(rest) = trimmed.strip_prefix("v/") {
                    serve_volume_plane(rest)
                } else if let Some(rest) = trimmed.strip_prefix("r/") {
                    serve_png(render3d::serve(rest))
                } else {
                    serve_file(&registry, &path)
                };
                responder.respond(response)
            });
        })
        .invoke_handler(tauri::generate_handler![
            scan_sources,
            cancel_scan,
            pet_metadata,
            paths_for_ids,
            list_media,
            take_launch_paths,
            write_export,
            cache_usage,
            clear_cache,
            bench_report,
            bench_enabled,
            process_memory,
            volume_build,
            volume_close,
            debug_enabled,
            simulate_blank_gpu,
            bench_leak_rounds,
            bench_slab,
            bench_reformat,
            bench_view,
            bench_close_after_ms,
            bench_voice_wav,
            bench_pixels,
            bench_paint_timeout_ms,
            probe_after_ms,
            probe_report,
            set_memory_mode,
            startup_elapsed_ms,
            startup_marks,
            store::history_list,
            store::history_record,
            store::history_remove,
            store::history_clear,
            store::settings_get,
            store::settings_set,
            anonymize::export_anonymized_dicom,
            pacs::pacs_echo,
            pacs::pacs_find,
            pacs::pacs_retrieve,
            pacs::pacs_send,
            sync::sync_status,
            sync::sync_sign_in,
            sync::sync_sign_out,
            sync::sync_upload_study,
            viewer_windows::list_monitors,
            viewer_windows::window_monitor,
            viewer_windows::open_viewer_window,
            viewer_windows::take_window_payload,
            viewer_windows::viewer_windows,
            viewer_windows::close_viewer_window,
            native_status,
            native_init,
            native_set_cells,
            native_set_wl,
            native_open_launch_study,
            native_scroll,
            native_close,
            native_warm,
            native_store_stats,
            native_layout,
            native_cell_series,
            native_cell_series_append,
            native_cell_view,
            native_cell_scroll,
            native_cell_close,
            native_pick,
            native_roi_stats,
            native_cell_plane,
            native_cell_render3d,
            native_mouse_wanted,
            updates::update_check,
            updates::update_apply,
            updates::update_mark_healthy,
            updates::entitlement_get,
            updates::config_refresh,
            updates::licence_set,
            updates::licence_clear,
        ])
        .build(context())
        .expect("error while building FlowRad Viewer");
    mark(0);
    // macOS: side buttons and tilt wheels for bindings (inactive until asked).
    #[cfg(target_os = "macos")]
    mac_mouse::install(app.handle());
    // Update rollback rule (cheap: one small file read). A version that failed
    // to start healthily is replaced by the previous one in the background.
    updates::on_startup(app.handle());
    #[cfg(windows)]
    if let Some(window) = app.get_webview_window("main") {
        trim_webview2(&window);
    }
    // Native mode (Phase 2): the GPU surface paints the window at once, while
    // WebView2 is still starting; the webview is transparent over it. Lazy
    // GPU without a study: the window's canvas colour until the page paints,
    // as on the JS renderer.
    if gpu_at_launch {
        if let (Some(window), Some(native)) = (app.get_webview_window("main"), app.try_state::<native::Shared>()) {
            let native = native.inner().clone();
            tauri::async_runtime::spawn(async move {
                let status = native.init(&window).await;
                if status.ready {
                    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                    if native.render(window.scale_factor().unwrap_or(1.0)).is_ok() {
                        if let Some(t) = STARTED.get() {
                            let _ = NATIVE_FIRST_PAINT.set(t.elapsed().as_secs_f64() * 1000.0);
                        }
                    }
                    if native::lazy_gpu() {
                        start_gpu_release_watch(native.clone(), window.clone());
                    }
                }
            });
        }
    }
    // Settings and history from pre-rename builds (app.radlearn.viewer, com.flowrad.tori).
    store::migrate_legacy_data(app.handle());

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

#[cfg(test)]
mod tests {
    #[test]
    fn open_warms_only_slices_the_native_renderer_draws() {
        let h = |pi: Option<&str>, frames: Option<i64>| crate::header::Header {
            photometric_interpretation: pi.map(str::to_string),
            number_of_frames: frames,
            ..Default::default()
        };
        assert!(super::native_draws(&h(None, None)));
        assert!(super::native_draws(&h(Some("MONOCHROME2"), Some(1))));
        assert!(super::native_draws(&h(Some("monochrome1"), None)));
        assert!(!super::native_draws(&h(Some("RGB"), None)));
        assert!(!super::native_draws(&h(Some("YBR_FULL_422"), Some(1))));
        assert!(!super::native_draws(&h(Some("MONOCHROME2"), Some(30))));
    }

    /// What this process holds, MB: private bytes on Windows (the allocator's
    /// view of the OS commit), the physical footprint on macOS (mimalloc
    /// decommits with MADV_FREE_REUSABLE: out of the footprint at once, still
    /// in RSS), anonymous resident memory on Linux (mimalloc purges there with
    /// MADV_DONTNEED, which its commit counter does not see).
    fn held_mb() -> f64 {
        #[cfg(target_os = "linux")]
        {
            let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
            if let Some(kb) = status.lines().find(|l| l.starts_with("RssAnon:")).and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok()) {
                return kb / 1024.0;
            }
        }
        super::commit_mb()
    }

    /// The option index we set at start-up really is mimalloc's purge delay
    /// (v3 default 1000 ms), and the heap statistic the close report uses reads.
    #[test]
    fn mimalloc_purge_option_and_heap_stat() {
        let delay = unsafe { libmimalloc_sys::mi_option_get(super::MI_OPTION_PURGE_DELAY) };
        assert!(delay == 1000 || delay == 0, "option {} is not purge_delay (value {delay})", super::MI_OPTION_PURGE_DELAY);
        let decommits = unsafe { libmimalloc_sys::mi_option_get(super::MI_OPTION_PURGE_DECOMMITS) };
        assert_eq!(decommits, 1, "option {} is not purge_decommits, or it is off", super::MI_OPTION_PURGE_DECOMMITS);
        let heap = super::heap_committed_mb().expect("mimalloc stats JSON");
        assert!(heap > 0.0, "heap committed {heap} MB");
    }

    /// The close-gate root cause: blocks allocated on idle rayon workers and
    /// freed on another thread stay with the workers' heaps until those
    /// threads collect. `release_memory` must hand them back to the OS.
    #[test]
    fn release_memory_returns_blocks_freed_across_threads() {
        use rayon::prelude::*;
        let base = held_mb();
        // 192 MB of 512 KB "slices", decoded (allocated and written) on the rayon pool.
        let slices: Vec<Vec<i16>> = (0..384).into_par_iter().map(|i| vec![1 + i as i16; 256 * 1024]).collect();
        let held = held_mb();
        drop(slices); // freed here, on the test thread (the close command's thread)
        let freed = held_mb();
        super::release_memory();
        let released = held_mb();
        eprintln!("held MB: base {base:.0} · 192 MB decoded {held:.0} · freed {freed:.0} · after release_memory {released:.0}");
        // Relative to the peak: other tests share this process and allocate meanwhile.
        assert!(held - base > 150.0, "the slices were not resident? {base:.0} -> {held:.0}");
        assert!(held - released > 128.0, "release_memory returned only {:.0} of 192 MB freed ({held:.0} -> {released:.0})", held - released);
    }

    /// FLOWRAD_FIXTURES=/tmp/fixtures cargo test inflates
    #[test]
    fn inflates_deflated_explicit_le() {
        let Ok(root) = crate::flowrad_env("FIXTURES") else {
            return;
        };
        let dir = std::path::Path::new(&root).join("ts/deflated-le");
        let mut files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .collect();
        files.sort();
        let bytes = super::inflate_to_explicit_le(&files[0]).expect("inflate");
        let out = std::env::temp_dir().join(format!("inflated-{}.dcm", std::process::id()));
        std::fs::write(&out, bytes).unwrap();
        let obj = dicom_object::open_file(&out).unwrap();
        assert_eq!(
            obj.meta().transfer_syntax().trim_end_matches('\0'),
            "1.2.840.10008.1.2.1"
        );
        let pixels = obj
            .element(dicom_dictionary_std::tags::PIXEL_DATA)
            .unwrap()
            .to_bytes()
            .unwrap();
        assert_eq!(pixels.len(), 512 * 512 * 2);
        let _ = std::fs::remove_file(out);
    }
}
