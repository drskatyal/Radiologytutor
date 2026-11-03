//! macOS: the native splash (splash.rs) drawn with AppKit.
//!
//! The main window is on screen ~140 ms after launch, but WKWebView needs
//! ~1 s more before the page paints (0.8.3, Intel MacBook). This view paints
//! the page's own boot splash (index.html `.boot`: the Owl Scan mark over
//! "FLOWRAD VIEWER", same place, size, font and colours) over the window's
//! content the moment the window and its webview are built, so the first frame
//! the reader sees is the splash, not an empty window.
//!
//! A plain `NSView` subclass added as the LAST subview of the window's content
//! view (wry's `WryWebViewParent`), i.e. above the WKWebView:
//! - `hitTest:` answers nil, so every click goes to the webview underneath,
//!   and the view never takes first responder (the webview keeps focus);
//! - autoresized with the content view and redrawn during a resize; AppKit
//!   gives the view's layer the window's backing scale (Retina) and redraws it
//!   when the window moves to a display with another scale;
//! - removed (`removeFromSuperview`) when the page has painted the same splash.
//!   The native renderer's CAMetalLayer is a sublayer added later to the
//!   content view's own layer, above every subview, so it is never covered.
//!
//! Everything here runs on the main thread (AppKit); splash.rs schedules it.

use std::cell::RefCell;
use std::ffi::c_void;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObjectProtocol};
use objc2::{define_class, msg_send, AllocAnyThread, ClassType, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAttributedStringNSStringDrawing, NSAutoresizingMaskOptions, NSColor, NSFont, NSFontAttributeName, NSFontWeightSemibold,
    NSForegroundColorAttributeName, NSImage, NSKernAttributeName, NSRectFill, NSResponder, NSView,
    NSViewLayerContentsRedrawPolicy, NSWindow,
};
use objc2_foundation::{
    NSAttributedString, NSAttributedStringKey, NSData, NSDictionary, NSNumber, NSObject, NSPoint, NSRect, NSSize,
    NSString,
};

use crate::splash::{layout, CANVAS, INK, LABEL, LETTER_SPACING_EM, MARK_PNG};

define_class!(
    // SAFETY: NSView has no subclassing requirements; the overridden methods
    // keep AppKit's signatures, and the class holds no ivars.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "FlowRadSplashView"]
    struct SplashView;

    impl SplashView {
        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            draw(self);
        }

        /// Click-through: no point of the splash is ever hit.
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> *mut NSView {
            std::ptr::null_mut()
        }

        /// Top-left origin, as the page's CSS and `splash::layout`.
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        /// Every pixel is painted: nothing behind needs drawing.
        #[unsafe(method(isOpaque))]
        fn is_opaque(&self) -> bool {
            true
        }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            false
        }
    }
);

thread_local! {
    /// The splash on screen (main thread only).
    static VIEW: RefCell<Option<Retained<SplashView>>> = const { RefCell::new(None) };
    /// The decoded mark, kept for redraws (resize, scale change).
    static MARK: RefCell<Option<Retained<NSImage>>> = const { RefCell::new(None) };
}

fn srgb(c: [u8; 3]) -> Retained<NSColor> {
    NSColor::colorWithSRGBRed_green_blue_alpha(c[0] as f64 / 255.0, c[1] as f64 / 255.0, c[2] as f64 / 255.0, 1.0)
}

fn mark() -> Option<Retained<NSImage>> {
    MARK.with(|m| {
        let mut m = m.borrow_mut();
        if m.is_none() {
            let data = NSData::with_bytes(MARK_PNG);
            *m = NSImage::initWithData(NSImage::alloc(), &data);
        }
        m.clone()
    })
}

/// The page's `.boot`, in points (= CSS px: the page is not zoomed).
fn draw(view: &SplashView) {
    let bounds = view.bounds();
    srgb(CANVAS).setFill();
    NSRectFill(bounds);
    let l = layout(bounds.size.width.round() as i32, bounds.size.height.round() as i32, 1.0);
    if let Some(image) = mark() {
        let rect = NSRect::new(
            NSPoint::new(l.mark_x as f64, l.mark_y as f64),
            NSSize::new(l.mark_size as f64, l.mark_size as f64),
        );
        // Respects the flipped context; at 2x the 112 px PNG maps 1:1.
        image.drawInRect(rect);
    }
    // system-ui on macOS is the system font (SF); weight 600.
    // SAFETY: NSFontWeightSemibold is an AppKit constant.
    let font = NSFont::systemFontOfSize_weight(l.line_px as f64, unsafe { NSFontWeightSemibold });
    let ink = srgb(INK);
    let kern = NSNumber::new_f64(l.line_px as f64 * LETTER_SPACING_EM);
    // SAFETY: AppKit's attribute-name constants.
    let keys: [&NSAttributedStringKey; 3] =
        unsafe { [NSFontAttributeName, NSForegroundColorAttributeName, NSKernAttributeName] };
    let values: [&AnyObject; 3] = [font.as_ref(), ink.as_ref(), kern.as_ref()];
    let attributes = NSDictionary::from_slices(&keys, &values);
    // SAFETY: the attributes have the types AppKit expects for these keys.
    let text = unsafe {
        NSAttributedString::initWithString_attributes(
            NSAttributedString::alloc(),
            &NSString::from_str(LABEL),
            Some(&attributes),
        )
    };
    let size = text.size();
    // The glyph cell (ascent + descent) centred in the 12 px line box, as CSS
    // line-height: 1 does; the label centred across the view.
    let cell = font.ascender() - font.descender();
    let origin = NSPoint::new(
        (bounds.size.width - size.width) / 2.0,
        l.line_top as f64 + (l.line_px as f64 - cell) / 2.0,
    );
    text.drawAtPoint(origin);
}

/// Put the splash over the window's content (main thread). False if there is
/// no window or content view to put it on.
pub fn attach(ns_window: *mut c_void) -> bool {
    let Some(mtm) = MainThreadMarker::new() else { return false };
    if ns_window.is_null() || VIEW.with(|v| v.borrow().is_some()) {
        return false;
    }
    // SAFETY: the caller passes the main window's NSWindow, alive for the call.
    let window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
    let Some(content) = window.contentView() else { return false };
    // SAFETY: -[NSView initWithFrame:] on a fresh instance of our subclass.
    let view: Retained<SplashView> = unsafe { msg_send![SplashView::alloc(mtm), initWithFrame: content.bounds()] };
    view.setWantsLayer(true);
    view.setLayerContentsRedrawPolicy(NSViewLayerContentsRedrawPolicy::DuringViewResize);
    view.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable);
    // Last subview = topmost: above the WKWebView.
    content.addSubview(&view);
    VIEW.with(|v| *v.borrow_mut() = Some(view));
    true
}

/// Draw the splash now and commit it to the WindowServer (main thread). True
/// when it went to a window that is on screen (visible, not minimised): the
/// WindowServer shows it at its next refresh.
pub fn flush() -> bool {
    VIEW.with(|v| {
        let v = v.borrow();
        let Some(view) = v.as_ref() else { return false };
        let Some(window) = view.window() else { return false };
        if !window.isVisible() || window.isMiniaturized() {
            return false;
        }
        // drawRect: into the view's layer, synchronously.
        view.display();
        // Commit the implicit transaction now rather than at the end of this
        // run-loop pass (QuartzCore is loaded by AppKit; looked up at run time).
        if let Some(cls) = AnyClass::get(c"CATransaction") {
            // SAFETY: +[CATransaction flush] takes no arguments.
            let _: () = unsafe { msg_send![cls, flush] };
        }
        true
    })
}

/// Take the splash off the window (main thread). None if it was not there;
/// otherwise how many splash views are still in the window's content view
/// afterwards (0: nothing stale left over the webview).
pub fn remove() -> Option<usize> {
    let view = VIEW.with(|v| v.borrow_mut().take())?;
    let window = view.window();
    view.removeFromSuperview();
    MARK.with(|m| m.borrow_mut().take());
    let stale = window
        .and_then(|w| w.contentView())
        .map(|content| {
            let views = content.subviews();
            (0..views.count()).filter(|&i| views.objectAtIndex(i).isKindOfClass(SplashView::class())).count()
        })
        .unwrap_or(0);
    Some(stale)
}
