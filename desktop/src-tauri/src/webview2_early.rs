//! Cold start, Windows: start the WebView2 browser process at the top of
//! `run`, in parallel with everything before the main window exists (Tauri's
//! build, the event loop, the window itself), instead of after it.
//!
//! Without this, wry asks for the WebView2 environment only once the main
//! window has been created, and the browser process (then its GPU and
//! renderer processes) starts from there: on the HP (desktop-v0.8.2) that is
//! ~1.1 s of the 1.3 s cold start. Here a background thread asks for an
//! environment with exactly the options wry will use (same user data folder,
//! browser arguments, language, scroll bar style, extensions off), so the
//! browser process is already starting when wry asks; WebView2 hands wry an
//! environment on that same browser process (it shares one browser process
//! between environments with identical options, as the viewer windows on
//! other monitors already rely on). The thread keeps its environment, and so
//! the browser process, alive until the main webview has started loading the
//! page (`release`), then lets it go.
//!
//! The options MUST stay identical to wry's (wry 0.57, `webview2/mod.rs`
//! `create_environment`): an environment with different options on a running
//! browser process fails with ERROR_INVALID_STATE, i.e. the app would not
//! start. `FLOWRAD_EARLY_WEBVIEW=0` turns this off (diagnosis, A/B).
//!
//! Other platforms: no-ops (WKWebView / WebKitGTK start in-process).

/// The browser arguments wry uses when the window config sets none.
#[cfg_attr(not(windows), allow(dead_code))]
const WRY_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// The browser arguments the main webview's environment is created with.
#[cfg_attr(not(windows), allow(dead_code))]
fn browser_args(config_args: Option<&str>) -> String {
    config_args.unwrap_or(WRY_DEFAULT_ARGS).to_string()
}

fn disabled() -> bool {
    crate::flowrad_env("EARLY_WEBVIEW").as_deref() == Ok("0")
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2Environment, ICoreWebView2EnvironmentOptions,
        COREWEBVIEW2_SCROLLBAR_STYLE_DEFAULT,
    };
    use webview2_com::{CoreWebView2EnvironmentOptions, CreateCoreWebView2EnvironmentCompletedHandler};
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::Globalization::{GetUserDefaultUILanguage, LCIDToLocaleName, LOCALE_ALLOW_NEUTRAL_NAMES, MAX_LOCALE_NAME};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, PostThreadMessageW, SetTimer, TranslateMessage, MSG, WM_QUIT, WM_TIMER};

    /// The holder thread's id (0: none yet).
    static THREAD: AtomicU32 = AtomicU32::new(0);
    /// `release` was called (possibly before the holder stored its id).
    static RELEASED: AtomicBool = AtomicBool::new(false);

    /// The holder lets the environment go after this long whatever happens.
    const HOLD_MAX_MS: u32 = 20_000;

    pub fn launch(config_args: Option<&str>, identifier: &str) {
        if super::disabled() {
            return;
        }
        // Tauri's webview data directory on Windows: app_local_data_dir().
        let Some(dir) = dirs::data_local_dir().map(|d| d.join(identifier)) else { return };
        let args = super::browser_args(config_args);
        // The main thread does not wait for any of it.
        let _ = std::thread::Builder::new().name("flowrad-webview2-early".into()).spawn(move || {
            // SAFETY: plain COM / Win32 on this thread's own STA (which also
            // gives it a message queue); every object is created, used and
            // released on this thread.
            if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
                return;
            }
            THREAD.store(unsafe { GetCurrentThreadId() }, Ordering::Release);
            hold(&dir, args);
            THREAD.store(0, Ordering::Release);
            unsafe { CoUninitialize() };
        });
    }

    /// Ask for the environment and keep it until `release` (or HOLD_MAX_MS).
    fn hold(dir: &std::path::Path, args: String) {
        let _ = std::fs::create_dir_all(dir);
        // Exactly wry 0.57's options (webview2/mod.rs create_environment).
        let options = CoreWebView2EnvironmentOptions::default();
        unsafe {
            options.set_additional_browser_arguments(args);
            options.set_are_browser_extensions_enabled(false);
            let lcid = GetUserDefaultUILanguage();
            let mut lang = [0; MAX_LOCALE_NAME as usize];
            LCIDToLocaleName(lcid as u32, Some(&mut lang), LOCALE_ALLOW_NEUTRAL_NAMES);
            options.set_language(String::from_utf16_lossy(&lang));
            options.set_scroll_bar_style(COREWEBVIEW2_SCROLLBAR_STYLE_DEFAULT);
        }
        // The environment, once created, lives in the handler's slot until
        // this function returns.
        let slot: std::rc::Rc<std::cell::RefCell<Option<ICoreWebView2Environment>>> = Default::default();
        let keep = slot.clone();
        let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |result, environment| {
            if result.is_ok() {
                *keep.borrow_mut() = environment;
            }
            Ok(())
        }));
        let asked = unsafe {
            CreateCoreWebView2EnvironmentWithOptions(
                PCWSTR::null(),
                &HSTRING::from(dir),
                &ICoreWebView2EnvironmentOptions::from(options),
                &handler,
            )
        };
        if asked.is_err() || RELEASED.load(Ordering::Acquire) {
            return;
        }
        // Pump this thread's messages (the completion arrives as one) until
        // `release` posts WM_QUIT, or the safety timer fires.
        unsafe {
            SetTimer(None, 0, HOLD_MAX_MS, None);
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.message == WM_TIMER && msg.hwnd.is_invalid() {
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        drop(slot.borrow_mut().take());
    }

    pub fn release() {
        RELEASED.store(true, Ordering::Release);
        let id = THREAD.swap(0, Ordering::AcqRel);
        if id != 0 {
            // SAFETY: posting to a thread id; failure (thread gone) is harmless.
            unsafe {
                let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }
}

/// Start the WebView2 browser process now (Windows). Call first thing in `run`.
pub fn launch(config_args: Option<&str>, identifier: &str) {
    #[cfg(windows)]
    imp::launch(config_args, identifier);
    #[cfg(not(windows))]
    let _ = (config_args, identifier, disabled());
}

/// The main webview is up (its page started loading): let the early
/// environment go. Idempotent.
pub fn release() {
    #[cfg(windows)]
    imp::release();
}

#[cfg(test)]
mod tests {
    #[test]
    fn browser_args_are_the_window_configs_or_wrys_default() {
        assert_eq!(super::browser_args(Some("--a --b")), "--a --b");
        assert_eq!(super::browser_args(None), super::WRY_DEFAULT_ARGS);
    }

    /// The main window's browser arguments are what the early launch passes:
    /// tauri.conf.json is the one source for both (and for viewer windows).
    #[test]
    fn main_window_config_has_browser_args() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = conf["app"]["windows"].as_array().unwrap().iter().find(|w| w["label"] == "main").unwrap();
        assert!(main["additionalBrowserArgs"].as_str().is_some_and(|a| a.contains("--disable-features=")));
        // Built in `setup` (after the splash is armed), not by Tauri from config.
        assert_eq!(main["create"], serde_json::Value::Bool(false));
        // Every other input of the environment options at its default, as
        // `launch` assumes (data folder = app_local_data_dir, extensions off,
        // default scroll bars). Setting any of these means changing `launch`.
        assert!(conf["app"]["appDirectoriesOverride"].is_null());
        for key in ["dataDirectory", "browserExtensionsEnabled", "scrollBarStyle", "proxyUrl"] {
            assert!(main[key].is_null(), "window config sets {key}: webview2_early.rs must match it");
        }
    }

    /// The options are copied from this wry version: an upgrade means
    /// re-checking them against wry's `create_environment`.
    #[test]
    fn wry_is_the_version_the_options_were_copied_from() {
        let lock = include_str!("../Cargo.lock");
        let wry = lock.split("[[package]]").find(|p| p.contains("name = \"wry\"")).expect("wry in Cargo.lock");
        assert!(wry.contains("version = \"0.57.1\""), "wry changed: re-check webview2_early.rs against its create_environment");
    }
}
