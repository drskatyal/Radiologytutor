//! macOS, diagnostics only (`FLOWRAD_DIAG=1` with the bench on): what the
//! app's main thread was doing while an open waited.
//!
//! - A main-thread heartbeat: a background thread posts a no-op to the main
//!   dispatch queue every 8 ms and records every reply that came back more
//!   than 40 ms late (the main thread was busy, or not running its run loop).
//! - The main window's occlusion state and the app's active state, as seen
//!   from the heartbeat (WebKit throttles a page whose window is occluded).
//! - Labelled events (`event`), with whether they ran on the main thread.
//! - `FLOWRAD_DIAG_SAMPLE=1`: `sample` of this process and of the newest
//!   WebKit processes for 3 s from the open (and once on a main-thread stall).
//!
//! Off (the default) nothing here runs: `enabled()` is read once.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

extern "C" {
    static _dispatch_main_q: c_void;
    fn dispatch_async_f(queue: *const c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));
    fn pthread_main_np() -> i32;
}

pub fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| crate::bench_on() && crate::flowrad_env("DIAG").as_deref() == Ok("1"))
}

fn sampling() -> bool {
    enabled() && crate::flowrad_env("DIAG_SAMPLE").as_deref() == Ok("1")
}

fn now_ms() -> f64 {
    crate::startup_elapsed_ms()
}

fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

static EVENTS: Mutex<Vec<(f64, String, bool)>> = Mutex::new(Vec::new());
/// (at ms, late ms): main-thread replies more than 40 ms late.
static GAPS: Mutex<Vec<(f64, f64)>> = Mutex::new(Vec::new());
static STATES: Mutex<Vec<(f64, String)>> = Mutex::new(Vec::new());
static SAMPLES: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// The main window's NSWindow (for its occlusion state).
static WINDOW: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
/// Posted at (µs since start, 0 = none in flight).
static POSTED_US: AtomicU64 = AtomicU64::new(0);

pub fn event(label: impl Into<String>) {
    if !enabled() {
        return;
    }
    let main = unsafe { pthread_main_np() } == 1;
    let mut v = EVENTS.lock();
    if v.len() < 2000 {
        v.push((r1(now_ms()), label.into(), main));
    }
}

pub fn set_window(ns_window: *mut c_void) {
    WINDOW.store(ns_window, Ordering::Release);
}

extern "C" fn pong(_: *mut c_void) {
    let posted = POSTED_US.swap(0, Ordering::AcqRel);
    let now = now_ms();
    if posted > 0 {
        let late = now - posted as f64 / 1000.0;
        if late > 40.0 {
            GAPS.lock().push((r1(now - late), r1(late)));
        }
    }
    record_state(now);
}

fn record_state(now: f64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let w = WINDOW.load(Ordering::Acquire) as *mut AnyObject;
    let mut state = String::new();
    // SAFETY: main thread (dispatch main queue); the main window lives for the session.
    unsafe {
        if !w.is_null() {
            let occlusion: usize = msg_send![w, occlusionState];
            let visible: bool = msg_send![w, isVisible];
            let key: bool = msg_send![w, isKeyWindow];
            state.push_str(&format!("occlusionVisible={} visible={visible} key={key}", occlusion & 2 != 0));
        }
        if let Some(cls) = objc2::runtime::AnyClass::get(c"NSApplication") {
            let app: *mut AnyObject = msg_send![cls, sharedApplication];
            if !app.is_null() {
                let active: bool = msg_send![app, isActive];
                state.push_str(&format!(" appActive={active}"));
            }
        }
    }
    let mut s = STATES.lock();
    if s.last().map(|(_, l)| l != &state).unwrap_or(true) && s.len() < 200 {
        s.push((r1(now), state));
    }
}

/// Start the heartbeat (any thread; no-op unless diagnostics are on).
pub fn start() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if !enabled() || STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let _ = std::thread::Builder::new().name("flowrad-diag-heartbeat".into()).spawn(|| {
        let t0 = Instant::now();
        let mut stall_samples = 0;
        loop {
            std::thread::sleep(Duration::from_millis(8));
            let posted = POSTED_US.load(Ordering::Acquire);
            if posted == 0 {
                POSTED_US.store(((now_ms() * 1000.0) as u64).max(1), Ordering::Release);
                // SAFETY: the main queue is a static; `pong` takes no context.
                unsafe { dispatch_async_f(&_dispatch_main_q as *const c_void, std::ptr::null_mut(), pong) };
            } else if sampling() && stall_samples < 2 && now_ms() - posted as f64 / 1000.0 > 150.0 {
                stall_samples += 1;
                sample_self(&format!("stall{stall_samples}"), 1);
                // One sample per stall.
                while POSTED_US.load(Ordering::Acquire) == posted {
                    std::thread::sleep(Duration::from_millis(8));
                }
            }
            if t0.elapsed() > Duration::from_secs(60) {
                break;
            }
        }
    });
}

fn out_dir() -> std::path::PathBuf {
    crate::flowrad_env("DIAG_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| std::env::temp_dir())
}

fn spawn_sample(pid: u32, name: &str, seconds: u32) {
    let file = out_dir().join(format!("sample-{}-{name}-{pid}.txt", std::process::id()));
    let cmd = format!(
        "sample {pid} {seconds} 2 -mayDie -file '{f}' >/dev/null 2>&1 || sudo -n sample {pid} {seconds} 2 -mayDie -file '{f}' >/dev/null 2>&1",
        f = file.display()
    );
    let at = r1(now_ms());
    let ok = std::process::Command::new("sh").arg("-c").arg(cmd).spawn().is_ok();
    SAMPLES.lock().push(format!("{at} ms: {name} pid {pid} for {seconds} s -> {} (spawned {ok})", file.display()));
}

fn sample_self(name: &str, seconds: u32) {
    spawn_sample(std::process::id(), name, seconds);
}

/// The open started: sample this process and the newest WebKit processes.
pub fn on_open() {
    event("open: scan_sources entered");
    if !sampling() {
        return;
    }
    static ONCE: AtomicBool = AtomicBool::new(false);
    if ONCE.swap(true, Ordering::AcqRel) {
        return;
    }
    sample_self("open-app", 3);
    for kind in ["WebContent", "GPU", "Networking"] {
        let out = std::process::Command::new("pgrep").args(["-n", "-f", &format!("com.apple.WebKit.{kind}")]).output();
        if let Ok(out) = out {
            if let Ok(pid) = String::from_utf8_lossy(&out.stdout).trim().parse::<u32>() {
                spawn_sample(pid, &format!("open-{kind}"), 3);
            }
        }
    }
}

/// Everything recorded so far (bench report time).
pub fn report() -> serde_json::Value {
    serde_json::json!({
        "events": EVENTS.lock().iter().map(|(t, l, m)| serde_json::json!([t, l, m])).collect::<Vec<_>>(),
        "mainLate": GAPS.lock().iter().map(|(t, g)| serde_json::json!([t, g])).collect::<Vec<_>>(),
        "states": STATES.lock().iter().map(|(t, s)| serde_json::json!([t, s])).collect::<Vec<_>>(),
        "samples": SAMPLES.lock().clone(),
    })
}
