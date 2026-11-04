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

/// DIAGNOSTIC (scratch branch): list WebKit SPI selectors that look like
/// memory / GC hooks (once), then ask the process pool for a JS GC.
pub fn diag_gc(window: &tauri::WebviewWindow) {
    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use objc2::{msg_send, sel};
    static LISTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !LISTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        for name in [c"WKProcessPool", c"WKWebView", c"WKWebsiteDataStore", c"WKPreferences"] {
            let Some(cls) = AnyClass::get(name) else { continue };
            let mut found = vec![];
            for (meta, methods) in [("-", cls.instance_methods()), ("+", cls.metaclass().instance_methods())] {
                for m in methods.iter() {
                    let n = m.name().name().to_string_lossy().into_owned();
                    let l = n.to_lowercase();
                    if ["memory", "garbage", "gc", "pressure", "cache", "terminate", "suspend", "purge", "release"].iter().any(|k| l.contains(k)) {
                        found.push(format!("{meta}{n}"));
                    }
                }
            }
            println!("FLOWRAD_DIAG selectors {}: {}", name.to_string_lossy(), found.join(" "));
        }
    }
    let _ = window.with_webview(|platform| {
        let view = platform.inner() as *mut AnyObject;
        if view.is_null() {
            return;
        }
        // SAFETY: diagnostic; the view is the window's WKWebView on the main thread.
        unsafe {
            let config: *mut AnyObject = msg_send![view, configuration];
            let pool: *mut AnyObject = msg_send![config, processPool];
            let s: Sel = sel!(_garbageCollectJavaScriptObjectsForTesting);
            let ok: bool = msg_send![pool, respondsToSelector: s];
            println!("FLOWRAD_DIAG gc respondsToSelector={ok}");
            if ok {
                let _: () = msg_send![pool, _garbageCollectJavaScriptObjectsForTesting];
            }
        }
    });
}
