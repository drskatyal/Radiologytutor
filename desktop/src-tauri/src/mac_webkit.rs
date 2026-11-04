//! macOS: hand back what WebKit's renderer keeps of a closed study.
//!
//! WebKit's WebContent process keeps finished resources in its in-memory cache
//! (decoded series thumbnails and previews from `dicom://p/...`) after the
//! page has let go of them; WebView2 drops them on its own when the page
//! does. On a study close the memory cache is emptied through the public
//! WKWebsiteDataStore API: only the memory cache, never local storage
//! (settings, bindings, history live there).

use objc2_foundation::{NSDate, NSSet, NSString};
use objc2_web_kit::{WKWebView, WKWebsiteDataTypeMemoryCache};

/// Empty the window's WebKit memory cache (asynchronous; returns at once).
pub fn drop_memory_cache(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|platform| {
        let view = platform.inner() as *const WKWebView;
        if view.is_null() {
            return;
        }
        // SAFETY: on macOS `inner()` is the window's WKWebView (wry's
        // subclass), alive for this call; with_webview runs on the main thread.
        unsafe {
            let store = (*view).configuration().websiteDataStore();
            let kinds: objc2::rc::Retained<NSSet<NSString>> = NSSet::from_slice(&[WKWebsiteDataTypeMemoryCache]);
            let done = block2::RcBlock::new(|| {});
            store.removeDataOfTypes_modifiedSince_completionHandler(&kinds, &NSDate::distantPast(), &done);
        }
    });
}

/// The page's timers and rendering at full rate from the start: WebKit's
/// hidden-page timer throttling and visibility-based process suppression off
/// (private WKPreferences setters, each sent only if this WebKit has it).
/// A viewer's page is never a background tab.
pub fn keep_page_awake(window: &tauri::WebviewWindow) {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    let _ = window.with_webview(|platform| {
        let view = platform.inner() as *const WKWebView;
        if view.is_null() {
            return;
        }
        // SAFETY: as in `drop_memory_cache`. -[WKWebViewConfiguration
        // preferences] returns the live WKPreferences; each private setter
        // takes one BOOL and is sent only when the object responds to it.
        unsafe {
            let config = (*view).configuration();
            let prefs: *mut AnyObject = msg_send![&*config, preferences];
            if prefs.is_null() {
                return;
            }
            let prefs = &*prefs;
            let responds: bool = msg_send![prefs, respondsToSelector: sel!(_setHiddenPageDOMTimerThrottlingEnabled:)];
            if responds {
                let _: () = msg_send![prefs, _setHiddenPageDOMTimerThrottlingEnabled: false];
            }
            let responds: bool = msg_send![prefs, respondsToSelector: sel!(_setHiddenPageDOMTimerThrottlingAutoIncreases:)];
            if responds {
                let _: () = msg_send![prefs, _setHiddenPageDOMTimerThrottlingAutoIncreases: false];
            }
            let responds: bool = msg_send![prefs, respondsToSelector: sel!(_setPageVisibilityBasedProcessSuppressionEnabled:)];
            if responds {
                let _: () = msg_send![prefs, _setPageVisibilityBasedProcessSuppressionEnabled: false];
            }
        }
    });
}
