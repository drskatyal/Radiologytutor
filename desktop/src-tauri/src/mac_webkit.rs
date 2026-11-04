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

/// Collect the closed study's JavaScript garbage now.
///
/// JavaScriptCore collects when the page allocates; a page back on the home
/// screen allocates almost nothing, so what the study left (its headers,
/// series, the viewer's unmounted DOM and their wrappers) stayed in the
/// WebContent process (CI, macOS: WebKit malloc +11 MB 30 s after a close,
/// growing ~8 MB per open / close round, with no GC in 60 s; a full
/// collection after the close brought it to +7 and ~1.5 MB per round).
/// WebView2 collects on its own on idle. WKWebView has no public call for
/// this; the process pool's `_garbageCollectJavaScriptObjectsForTesting`
/// (WKProcessPoolPrivate, a synchronous full collection in each web process)
/// is used when this WebKit has it, and skipped when it does not.
pub fn collect_js_garbage(window: &tauri::WebviewWindow) {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{msg_send, sel};
    let _ = window.with_webview(|platform| {
        let view = platform.inner() as *mut AnyObject;
        if view.is_null() {
            return;
        }
        // SAFETY: `inner()` is the window's WKWebView, alive for this call, on
        // the main thread (with_webview); `configuration` and `processPool`
        // are public and never nil; the private selector is only sent when
        // the pool answers to it (it takes no arguments, returns nothing).
        unsafe {
            let config: *mut AnyObject = msg_send![view, configuration];
            if config.is_null() {
                return;
            }
            let pool: *mut AnyObject = msg_send![config, processPool];
            if pool.is_null() {
                return;
            }
            let responds: Bool = msg_send![pool, respondsToSelector: sel!(_garbageCollectJavaScriptObjectsForTesting)];
            if responds.as_bool() {
                let _: () = msg_send![pool, _garbageCollectJavaScriptObjectsForTesting];
            }
        }
    });
}

/// Paint the page's layers on the CPU, not with WebKit's accelerated (Metal)
/// drawing. Call right after the main webview is built, before the page loads.
///
/// The page is the UI chrome over the native renderer's CAMetalLayer: text,
/// borders, icons, a few overlays. With accelerated drawing WebKit paints
/// each layer through Core Animation's Metal-backed CG renderer, and the
/// WebContent main thread waits for that GPU work inside its rendering
/// update. CI (macOS, 3-CPU runners with a paravirtualised GPU), spindump of
/// the WebContent process during a warm open: 0.5-1 s of its main thread in
/// `RemoteLayerTreeDrawingArea::updateRendering` →
/// `paintReachableBackingStoreContents` → `CA::OGL::MetalContext::flush` →
/// `semaphore_wait`, right as the study's overlay and then the study view
/// painted for the first time. No timer, IPC reply or ResizeObserver ran
/// meanwhile (a worker thread in the same process kept time), so the first
/// viewport asked for its series 1.3-1.9 s after the series was hung, and the
/// first image waited for it. The images are drawn by our own Metal renderer,
/// not by WebKit; the page's own 2D painting is small and cheap on the CPU,
/// and no longer queues behind the GPU.
///
/// WKPreferences' private `_setAcceleratedDrawingEnabled:`, sent only when
/// this WebKit answers to it (otherwise WebKit's default stays).
/// `FLOWRAD_WEBKIT_GPU_PAINT=1` keeps WebKit's default, for A/B runs.
pub fn paint_on_cpu(window: &tauri::WebviewWindow) {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{msg_send, sel};
    if crate::flowrad_env("WEBKIT_GPU_PAINT").as_deref() == Ok("1") {
        crate::trace("webkit: accelerated drawing kept (FLOWRAD_WEBKIT_GPU_PAINT)");
        return;
    }
    let _ = window.with_webview(|platform| {
        let view = platform.inner() as *mut AnyObject;
        if view.is_null() {
            return;
        }
        // SAFETY: `inner()` is the window's WKWebView, alive for this call, on
        // the main thread (with_webview); `configuration` and `preferences`
        // are public and return live objects (checked for nil); the private
        // setter takes one BOOL and its getter returns one, each sent only
        // when the object answers to it.
        unsafe {
            let config: *mut AnyObject = msg_send![view, configuration];
            if config.is_null() {
                return;
            }
            let prefs: *mut AnyObject = msg_send![config, preferences];
            if prefs.is_null() {
                return;
            }
            let can_set: Bool = msg_send![prefs, respondsToSelector: sel!(_setAcceleratedDrawingEnabled:)];
            if !can_set.as_bool() {
                crate::trace("webkit: no accelerated-drawing switch");
                return;
            }
            let _: () = msg_send![prefs, _setAcceleratedDrawingEnabled: Bool::NO];
            let can_get: Bool = msg_send![prefs, respondsToSelector: sel!(_acceleratedDrawingEnabled)];
            let still_on = can_get.as_bool() && {
                let on: Bool = msg_send![prefs, _acceleratedDrawingEnabled];
                on.as_bool()
            };
            crate::trace(if still_on { "webkit: accelerated drawing still on" } else { "webkit: page painted on the CPU" });
        }
    });
}
