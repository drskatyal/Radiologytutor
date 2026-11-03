//! macOS: extra mouse buttons and wheel tilt for the reader's bindings.
//!
//! WKWebView reports every "other" mouse button as the middle button, so the
//! side buttons of a gaming / programmable mouse (back, forward, 6, 7…) can't
//! be told apart in the page, and it scrolls a tilt wheel with the same pixel
//! deltas as a trackpad swipe. An AppKit local event monitor sees the real
//! `buttonNumber` and `hasPreciseScrollingDeltas`, and hands those inputs to
//! the window's page as a `native-mouse` event; the page re-dispatches them
//! as ordinary pointer / wheel events, so commands, drags and the
//! "press the button you want to bind" prompt all work unchanged.
//!
//! Mirrors the Windows raw-input design: the monitor is installed once, but
//! it does nothing unless the page asked for it (a binding uses a side button
//! or tilt, or the capture prompt is open) — a single atomic load otherwise.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Side buttons (`buttonNumber` ≥ 3) are taken from the page and forwarded.
static BUTTONS: AtomicBool = AtomicBool::new(false);
/// Notched horizontal wheel / tilt is forwarded as a line-mode tilt.
static TILT: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeMouse {
    /// "down", "up" (a side button) or "tilt".
    kind: &'static str,
    /// The DOM button index (back = 3, forward = 4, then 5, 6…).
    button: i64,
    /// Tilt direction: -1 left, 1 right.
    dir: i8,
    /// Page coordinates (CSS px, top-left origin).
    x: f64,
    y: f64,
    ctrl: bool,
    meta: bool,
    alt: bool,
    shift: bool,
}

/// The page's request: which native inputs it wants forwarded.
pub fn set_wanted(buttons: bool, tilt: bool) {
    BUTTONS.store(buttons, Ordering::Relaxed);
    TILT.store(tilt, Ordering::Relaxed);
}

/// Install the monitor (once, on the main thread, from `setup`).
pub fn install(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let block = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a valid event for the call.
        let ev = unsafe { event.as_ref() };
        if forward(ev) {
            std::ptr::null_mut() // taken from the page
        } else {
            event.as_ptr()
        }
    });
    let mask = NSEventMask::OtherMouseDown | NSEventMask::OtherMouseUp | NSEventMask::ScrollWheel;
    // SAFETY: called on the main thread; the block lives as long as the app.
    let monitor: Option<Retained<AnyObject>> = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
    // The monitor (and its block) stay installed for the life of the app.
    std::mem::forget(monitor);
    std::mem::forget(block);
}

/// Forward `ev` to its window's page if it is an input the page asked for;
/// true when it was taken (the page must not also see WebKit's version).
fn forward(ev: &NSEvent) -> bool {
    let kind = ev.r#type();
    let (name, button, dir) = if kind == NSEventType::OtherMouseDown || kind == NSEventType::OtherMouseUp {
        let n = ev.buttonNumber() as i64;
        // 2 is the middle button: WebKit reports it correctly.
        if n < 3 || !BUTTONS.load(Ordering::Relaxed) {
            return false;
        }
        (if kind == NSEventType::OtherMouseDown { "down" } else { "up" }, n, 0i8)
    } else if kind == NSEventType::ScrollWheel {
        if !TILT.load(Ordering::Relaxed) {
            return false;
        }
        // Trackpads and the Magic Mouse scroll with precise deltas: never tilt.
        let (dx, dy) = (ev.scrollingDeltaX(), ev.scrollingDeltaY());
        if ev.hasPreciseScrollingDeltas() || dx == 0.0 || dy != 0.0 {
            return false;
        }
        // AppKit's deltaX is positive for a tilt to the left.
        ("tilt", 0, if dx > 0.0 { -1i8 } else { 1i8 })
    } else {
        return false;
    };
    let Some(app) = APP.get() else { return false };
    let Some(mtm) = MainThreadMarker::new() else { return false };
    let Some(window) = ev.window(mtm) else { return false };
    let target = Retained::as_ptr(&window) as *mut c_void;
    let Some(webview) = app.webview_windows().into_values().find(|w| w.ns_window().map(|p| p == target).unwrap_or(false)) else {
        return false;
    };
    // Window coordinates have a bottom-left origin; the page's, top-left.
    let p = ev.locationInWindow();
    let height = window.contentView().map(|v| v.frame().size.height).unwrap_or(0.0);
    let flags = ev.modifierFlags();
    let payload = NativeMouse {
        kind: name,
        button,
        dir,
        x: p.x,
        y: height - p.y,
        ctrl: flags.contains(NSEventModifierFlags::Control),
        meta: flags.contains(NSEventModifierFlags::Command),
        alt: flags.contains(NSEventModifierFlags::Option),
        shift: flags.contains(NSEventModifierFlags::Shift),
    };
    // To this window's page only (a second viewer window must not act on it).
    app.emit_to(webview.label(), "native-mouse", payload).is_ok()
}
