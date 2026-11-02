//! Viewer windows on other monitors.
//!
//! The main window opens a secondary viewer window (`viewer-<n>`) on a chosen
//! monitor and hands it what to show: the already-scanned study headers (file
//! ids are process-wide, so nothing is rescanned) and the layout. The handoff
//! is a JSON string parked here until the new window takes it once.
//!
//! Each secondary window is its own webview: closing it tears the page down
//! and with it every decoded image it held, so memory goes back to what the
//! main window alone uses.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
pub struct WindowHandoff(pub Mutex<HashMap<String, String>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorDto {
    /// OS name (e.g. `\\.\DISPLAY2`): stable across launches, used to restore.
    name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    /// Device pixels per CSS pixel (1.5 = 150 %).
    scale: f64,
}

#[tauri::command]
pub fn list_monitors(app: AppHandle) -> Vec<MonitorDto> {
    app.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(i, m)| MonitorDto {
            name: m.name().cloned().unwrap_or_else(|| format!("monitor-{}", i + 1)),
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            scale: m.scale_factor(),
        })
        .collect()
}

/// The monitor a window is on now (by its centre), for "remember where it was".
#[tauri::command]
pub fn window_monitor(app: AppHandle, label: String) -> Option<String> {
    let w = app.get_webview_window(&label)?;
    w.current_monitor().ok().flatten().and_then(|m| m.name().cloned())
}

/// Open (or move) viewer window `label` on the monitor named `monitor`
/// (none: beside the main window), full screen there. `payload` is what the
/// window shows; it takes it with `take_window_payload`.
/// `async` on purpose: building a webview window inside a synchronous
/// command deadlocks on Windows (the command runs on the main thread, which
/// window creation waits for). Linux never showed it; the Windows
/// multi-window bench hung until its watchdog.
#[tauri::command]
pub async fn open_viewer_window(app: AppHandle, label: String, monitor: Option<String>, payload: String, title: String) -> Result<(), String> {
    if !label.starts_with("viewer-") {
        return Err("viewer windows are named viewer-<n>".into());
    }
    let target = monitor.and_then(|name| {
        app.available_monitors()
            .unwrap_or_default()
            .into_iter()
            .find(|m| m.name().map(|n| *n == name).unwrap_or(false))
    });
    app.state::<WindowHandoff>().0.lock().insert(label.clone(), payload);

    if let Some(existing) = app.get_webview_window(&label) {
        // Already open: move it (the page reloads its handoff on "viewer-handoff").
        if let Some(m) = &target {
            let _ = existing.set_fullscreen(false);
            let _ = existing.set_position(PhysicalPosition::new(m.position().x + 40, m.position().y + 40));
            let _ = existing.set_fullscreen(true);
        }
        let _ = existing.set_focus();
        let _ = tauri::Emitter::emit_to(&app, label.as_str(), "viewer-handoff", ());
        return Ok(());
    }

    // Same browser arguments as the main window: WebView2 shares one browser
    // process only between webviews created with identical options.
    let main_args = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .and_then(|w| w.additional_browser_args.clone());
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("index.html?window={label}").into()))
        .title(title)
        .min_inner_size(640.0, 480.0)
        .background_color(tauri::window::Color(11, 13, 16, 255))
        .visible(false);
    if let Some(args) = main_args {
        builder = builder.additional_browser_args(&args);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    match &target {
        // Physical coordinates: correct on mixed-DPI desks (a 150 % monitor
        // beside a 100 % one); the window adopts the target monitor's scale.
        Some(m) => {
            let _ = window.set_position(PhysicalPosition::new(m.position().x + 40, m.position().y + 40));
            let _ = window.set_size(PhysicalSize::new(m.size().width.saturating_sub(80).max(640), m.size().height.saturating_sub(80).max(480)));
            // Full screen on that display (the reading-room norm); F11 / Esc in the app leaves it.
            let _ = window.set_fullscreen(true);
        }
        None => {
            let _ = window.set_size(tauri::LogicalSize::new(1200.0, 800.0));
        }
    }
    let _ = window.show();
    Ok(())
}

/// The handoff for this window (once).
#[tauri::command]
pub fn take_window_payload(state: tauri::State<WindowHandoff>, label: String) -> Option<String> {
    state.0.lock().remove(&label)
}

/// Secondary viewer windows open now.
#[tauri::command]
pub fn viewer_windows(app: AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app.webview_windows().into_keys().filter(|l| l.starts_with("viewer-")).collect();
    labels.sort();
    labels
}

#[tauri::command]
pub fn close_viewer_window(app: AppHandle, label: String) {
    if label.starts_with("viewer-") {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        }
    }
}
