//! Cold start: the native splash, the first frame the reader sees.
//!
//! WebView2 needs ~1.1 s on the HP (desktop-v0.8.2) before it starts loading
//! the page, so the page's first paint came at ~1.3 s, with an empty window
//! before it. Here Rust paints the page's own boot splash (index.html
//! `.boot`: the Owl Scan mark over "FLOWRAD VIEWER", same place, size and
//! colours) with GDI as soon as the main window is on screen. No GPU device
//! and no WebView2 are involved, so it does not wait for either. The page then
//! paints the same splash, and the native one goes (`dismiss`): the hand-over
//! is invisible.
//!
//! Windows: an owned, click-through, non-activating popup over the main
//! window's client area. An owned window stays above its owner and DWM
//! composes it on its own, so neither WebView2's DirectComposition content nor
//! the native renderer's swap chain (both in the main window) can cover it,
//! and it never touches either. It follows the window (moves, resizes, DPI).
//! It goes when the page reports that it has painted (`splash_done`), 1 s
//! after the page finished loading if the page never says so, and after 15 s
//! whatever happens.
//!
//! The paint is timed honestly: `painted_ms` is set only once DWM has composed
//! a frame with the splash in it (DwmFlush returns after the next composition),
//! and only if the main window is visible and not minimised. That is what
//! `bench.mjs coldstart` reports as the native first paint.
//!
//! macOS (mac_splash.rs): an AppKit view over the window's content, above
//! the WKWebView, added the moment the main window and its webview are built
//! (`attach`), click-through, resized with the window. WKWebView needs ~1 s
//! more before the page paints (0.8.3: 1183 ms median on an Intel MacBook).
//! The view is drawn and its frame committed to the WindowServer at once
//! (`CATransaction flush`, the counterpart of DwmFlush), and `painted_ms` is
//! set then, if the window is visible and not minimised. It goes the same
//! three ways as on Windows: `splash_done`, 1 s after the page loaded, 15 s.
//! With `FLOWRAD_BENCH=1` its dismissal is reported as a `FLOWRAD_SPLASH`
//! line (how, when, and that no splash view was left in the window).
//!
//! `FLOWRAD_NATIVE_SPLASH=0` turns it off (A/B, diagnosis). Linux: no native
//! splash (WebKitGTK paints the page's splash); the calls are no-ops.

// The drawing helpers are used by the Windows painter (and the tests) only.
#![cfg_attr(not(windows), allow(dead_code))]

/// --canvas (#0B0D10): the app background, the splash background.
pub const CANVAS: [u8; 3] = [0x0b, 0x0d, 0x10];
/// The splash label colour (#A9C4B9).
pub const INK: [u8; 3] = [0xa9, 0xc4, 0xb9];
/// `.boot span`, after `text-transform: uppercase`.
pub const LABEL: &str = "FLOWRAD VIEWER";

/// The mark: the same 112 px PNG (2x of 56 CSS px) inlined in index.html.
pub(crate) const MARK_PNG: &[u8] = include_bytes!("../icons/splash-owl.png");

// `.boot` (index.html), CSS px: a centred column of the 56 px mark, a 20 px
// gap and a 12 px line (font 600 12px/1, letter-spacing 0.18em), 8 px of
// bottom padding.
const MARK_PX: f64 = 56.0;
const GAP_PX: f64 = 20.0;
const LINE_PX: f64 = 12.0;
const PAD_BOTTOM_PX: f64 = 8.0;
pub(crate) const LETTER_SPACING_EM: f64 = 0.18;

/// Where the splash draws, in physical pixels of a `width` x `height` client
/// area at `scale` (physical px per CSS px).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    pub mark_x: i32,
    pub mark_y: i32,
    pub mark_size: i32,
    /// Top of the label's 12 px line box.
    pub line_top: i32,
    /// The line box height = the font size (line-height 1).
    pub line_px: i32,
    pub letter_spacing: i32,
}

pub fn layout(width: i32, height: i32, scale: f64) -> Layout {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let mark = (MARK_PX * scale).round() as i32;
    let content = (MARK_PX + GAP_PX + LINE_PX) * scale;
    let top = ((height as f64 - PAD_BOTTOM_PX * scale - content) / 2.0).round() as i32;
    Layout {
        mark_x: (width - mark) / 2,
        mark_y: top,
        mark_size: mark,
        line_top: top + ((MARK_PX + GAP_PX) * scale).round() as i32,
        line_px: (LINE_PX * scale).round() as i32,
        letter_spacing: (LINE_PX * LETTER_SPACING_EM * scale).round() as i32,
    }
}

/// The mark decoded: (width, height, RGBA8 rows).
fn decode_mark() -> Option<(usize, usize, Vec<u8>)> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(MARK_PNG));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::ALPHA);
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return None;
    }
    buf.truncate(info.buffer_size());
    Some((info.width as usize, info.height as usize, buf))
}

/// The mark at `size` x `size` px, composited over the canvas: BGRA rows,
/// top-down, opaque (a GDI DIB). Bilinear in premultiplied alpha (at the
/// usual 2:1 it is the 2x2 box average, as the browser's downscale).
pub fn mark_bgra(size: u32) -> Option<Vec<u8>> {
    let (w, h, rgba) = decode_mark()?;
    let size = size.clamp(1, 1024) as usize;
    let texel = |x: usize, y: usize| {
        let i = (y * w + x) * 4;
        let a = rgba[i + 3] as f64 / 255.0;
        [rgba[i] as f64 * a, rgba[i + 1] as f64 * a, rgba[i + 2] as f64 * a, a]
    };
    let mut out = Vec::with_capacity(size * size * 4);
    for y in 0..size {
        let fy = ((y as f64 + 0.5) * h as f64 / size as f64 - 0.5).clamp(0.0, (h - 1) as f64);
        let (y0, ty) = (fy.floor() as usize, fy.fract());
        let y1 = (y0 + 1).min(h - 1);
        for x in 0..size {
            let fx = ((x as f64 + 0.5) * w as f64 / size as f64 - 0.5).clamp(0.0, (w - 1) as f64);
            let (x0, tx) = (fx.floor() as usize, fx.fract());
            let x1 = (x0 + 1).min(w - 1);
            let (a, b, c, d) = (texel(x0, y0), texel(x1, y0), texel(x0, y1), texel(x1, y1));
            let mut p = [0.0; 4];
            for k in 0..4 {
                p[k] = (a[k] * (1.0 - tx) + b[k] * tx) * (1.0 - ty) + (c[k] * (1.0 - tx) + d[k] * tx) * ty;
            }
            // Over the canvas: premultiplied colour + canvas * (1 - alpha).
            let over = |k: usize| (p[k] + CANVAS[k] as f64 * (1.0 - p[3])).round().clamp(0.0, 255.0) as u8;
            out.extend_from_slice(&[over(2), over(1), over(0), 255]);
        }
    }
    Some(out)
}

fn disabled() -> bool {
    crate::flowrad_env("NATIVE_SPLASH").as_deref() == Ok("0")
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
    use std::sync::OnceLock;
    use std::time::Instant;

    use windows::core::{w, BOOL, PCWSTR};
    use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
    use windows::Win32::Graphics::Dwm::DwmFlush;
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, ClientToScreen, CreateFontW, CreateSolidBrush, DeleteObject, EndPaint, FillRect, GdiFlush,
        GetTextExtentPoint32W, GetTextMetricsW, SelectObject, SetBkMode, SetDIBitsToDevice, SetTextCharacterExtra,
        SetTextColor, TextOutW, UpdateWindow, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CLEARTYPE_QUALITY,
        CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS, FF_DONTCARE, FW_SEMIBOLD,
        OUT_DEFAULT_PRECIS, PAINTSTRUCT, TEXTMETRICW, TRANSPARENT,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, EnumThreadWindows, GetClientRect, GetWindowTextW, IsIconic,
        IsWindowVisible, KillTimer, PostMessageW, RegisterClassExW, SetLayeredWindowAttributes, SetTimer,
        SetWindowPos, ShowWindow, CS_HREDRAW, CS_VREDRAW, EVENT_OBJECT_LOCATIONCHANGE, HCURSOR, HICON,
        HTTRANSPARENT, HWND_MESSAGE, LWA_ALPHA, MA_NOACTIVATE, OBJID_WINDOW, SWP_NOACTIVATE, SWP_NOZORDER,
        SW_SHOWNOACTIVATE, WINDOW_EX_STYLE, WINDOW_STYLE, WINEVENT_OUTOFCONTEXT, WM_APP, WM_CLOSE, WM_DESTROY,
        WM_ERASEBKGND, WM_MOUSEACTIVATE, WM_NCHITTEST, WM_PAINT, WM_TIMER, WNDCLASSEXW, WS_EX_LAYERED,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
    };

    use super::{layout, mark_bgra, CANVAS, INK, LABEL};

    const CLASS: PCWSTR = w!("FlowRadSplash");
    /// Scout: look for the main window now.
    const MSG_FIND: u32 = WM_APP + 0x51;
    /// Splash: go after WPARAM ms.
    const MSG_GO_AFTER: u32 = WM_APP + 0x52;
    const TIMER_FIND: usize = 1;
    const TIMER_GO: usize = 2;
    const TIMER_LAST_RESORT: usize = 3;
    /// The scout retries every 10 ms for up to 5 s.
    const FIND_EVERY_MS: u32 = 10;
    const FIND_TRIES: u32 = 500;
    const LAST_RESORT_MS: u32 = 15_000;

    static T0: OnceLock<Instant> = OnceLock::new();
    static TITLE: OnceLock<Vec<u16>> = OnceLock::new();
    static MAIN: AtomicIsize = AtomicIsize::new(0);
    static SPLASH: AtomicIsize = AtomicIsize::new(0);
    static HOOK: AtomicIsize = AtomicIsize::new(0);
    static TRIES: AtomicU32 = AtomicU32::new(0);
    /// Dismissed (or given up): never show it (again).
    static DONE: AtomicBool = AtomicBool::new(false);
    /// A DwmFlush wait is running.
    static TIMING: AtomicBool = AtomicBool::new(false);
    static PAINTED_MS: OnceLock<f64> = OnceLock::new();

    fn handle(v: isize) -> Option<HWND> {
        (v != 0).then_some(HWND(v as *mut _))
    }

    fn rgb(c: [u8; 3]) -> COLORREF {
        COLORREF(c[0] as u32 | (c[1] as u32) << 8 | (c[2] as u32) << 16)
    }

    fn instance() -> Option<HINSTANCE> {
        // SAFETY: the module handle of this executable.
        unsafe { GetModuleHandleW(PCWSTR::null()) }.ok().map(|m| HINSTANCE(m.0))
    }

    /// Call on the main thread right before the main window is built. The
    /// window is found from inside wry's message pump (WebView2 start-up),
    /// i.e. as soon as it is on screen.
    pub fn arm(t0: Instant, title: &str) {
        if super::disabled() || DONE.load(Ordering::Acquire) {
            return;
        }
        let _ = T0.set(t0);
        let _ = TITLE.set(title.encode_utf16().collect());
        let Some(instance) = instance() else { return };
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            // The content is centred: repaint all of it on a resize.
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: HICON::default(),
            hCursor: HCURSOR::default(),
            hbrBackground: Default::default(),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: CLASS,
            hIconSm: HICON::default(),
        };
        // SAFETY: plain Win32 on the main thread; the class lives for the process.
        unsafe {
            if RegisterClassExW(&class) == 0 {
                return;
            }
            // A message-only "scout": its posted message is dispatched by the
            // first message pump after the window exists (wry's, while
            // WebView2 starts).
            let Ok(scout) = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                CLASS,
                PCWSTR::null(),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(instance),
                None,
            ) else {
                return;
            };
            let _ = PostMessageW(Some(scout), MSG_FIND, WPARAM(0), LPARAM(0));
        }
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        let is_splash = hwnd.0 as isize == SPLASH.load(Ordering::Acquire);
        // SAFETY (all arms): Win32 calls on this window, on its own thread.
        unsafe {
            match msg {
                MSG_FIND => find_main(hwnd),
                WM_TIMER if wparam.0 == TIMER_FIND => find_main(hwnd),
                WM_TIMER if wparam.0 == TIMER_GO || wparam.0 == TIMER_LAST_RESORT => {
                    let _ = DestroyWindow(hwnd);
                }
                MSG_GO_AFTER => {
                    SetTimer(Some(hwnd), TIMER_GO, wparam.0 as u32, None);
                }
                WM_CLOSE => {
                    let _ = DestroyWindow(hwnd);
                }
                WM_PAINT if is_splash => paint(hwnd),
                WM_ERASEBKGND => return LRESULT(1),
                WM_NCHITTEST => return LRESULT(HTTRANSPARENT as isize),
                WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
                WM_DESTROY if is_splash => {
                    SPLASH.store(0, Ordering::Release);
                    DONE.store(true, Ordering::Release);
                    let hook = HOOK.swap(0, Ordering::AcqRel);
                    if hook != 0 {
                        let _ = UnhookWinEvent(HWINEVENTHOOK(hook as *mut _));
                    }
                }
                _ => return DefWindowProcW(hwnd, msg, wparam, lparam),
            }
        }
        LRESULT(0)
    }

    /// The scout: is the main window on screen yet? Then show the splash.
    unsafe fn find_main(scout: HWND) {
        unsafe {
            let _ = KillTimer(Some(scout), TIMER_FIND);
            if DONE.load(Ordering::Acquire) {
                let _ = DestroyWindow(scout);
                return;
            }
            let mut found = HWND::default();
            let _ = EnumThreadWindows(GetCurrentThreadId(), Some(is_main), LPARAM(&mut found as *mut HWND as isize));
            if found.is_invalid() {
                if TRIES.fetch_add(1, Ordering::Relaxed) < FIND_TRIES {
                    SetTimer(Some(scout), TIMER_FIND, FIND_EVERY_MS, None);
                } else {
                    let _ = DestroyWindow(scout);
                }
                return;
            }
            let _ = DestroyWindow(scout);
            show(found);
        }
    }

    /// EnumThreadWindows: the visible, not minimised window with our title.
    unsafe extern "system" fn is_main(hwnd: HWND, out: LPARAM) -> BOOL {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return BOOL(1);
            }
            let mut buf = [0u16; 128];
            let n = GetWindowTextW(hwnd, &mut buf).max(0) as usize;
            if TITLE.get().is_some_and(|t| buf[..n] == t[..]) {
                *(out.0 as *mut HWND) = hwnd;
                return BOOL(0);
            }
        }
        BOOL(1)
    }

    /// The main window's client area, screen coordinates.
    unsafe fn client_on_screen(main: HWND) -> Option<RECT> {
        unsafe {
            let mut rc = RECT::default();
            GetClientRect(main, &mut rc).ok()?;
            let mut origin = POINT { x: 0, y: 0 };
            if !ClientToScreen(main, &mut origin).as_bool() {
                return None;
            }
            Some(RECT { left: origin.x, top: origin.y, right: origin.x + rc.right, bottom: origin.y + rc.bottom })
        }
    }

    unsafe fn show(main: HWND) {
        unsafe {
            let Some(rc) = client_on_screen(main) else { return };
            let Some(instance) = instance() else { return };
            let ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
            // Owned by the main window (the parent argument of a WS_POPUP).
            let Ok(splash) = CreateWindowExW(
                ex,
                CLASS,
                PCWSTR::null(),
                WS_POPUP,
                rc.left,
                rc.top,
                rc.right - rc.left,
                rc.bottom - rc.top,
                Some(main),
                None,
                Some(instance),
                None,
            ) else {
                return;
            };
            MAIN.store(main.0 as isize, Ordering::Release);
            SPLASH.store(splash.0 as isize, Ordering::Release);
            // Layered for click-through (WS_EX_TRANSPARENT); fully opaque.
            let _ = SetLayeredWindowAttributes(splash, COLORREF(0), 255, LWA_ALPHA);
            SetTimer(Some(splash), TIMER_LAST_RESORT, LAST_RESORT_MS, None);
            let hook = SetWinEventHook(
                EVENT_OBJECT_LOCATIONCHANGE,
                EVENT_OBJECT_LOCATIONCHANGE,
                None,
                Some(on_location),
                GetCurrentProcessId(),
                GetCurrentThreadId(),
                WINEVENT_OUTOFCONTEXT,
            );
            HOOK.store(hook.0 as isize, Ordering::Release);
            let _ = ShowWindow(splash, SW_SHOWNOACTIVATE);
            // Paint now (WM_PAINT, synchronously), not at the pump's leisure.
            let _ = UpdateWindow(splash);
        }
    }

    /// The main window moved or resized: follow it.
    unsafe extern "system" fn on_location(
        _hook: HWINEVENTHOOK,
        _event: u32,
        hwnd: HWND,
        id_object: i32,
        _id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if id_object != OBJID_WINDOW.0 || hwnd.0 as isize != MAIN.load(Ordering::Acquire) {
            return;
        }
        let Some(splash) = handle(SPLASH.load(Ordering::Acquire)) else { return };
        unsafe {
            if IsIconic(hwnd).as_bool() {
                return;
            }
            if let Some(rc) = client_on_screen(hwnd) {
                let _ = SetWindowPos(
                    splash,
                    None,
                    rc.left,
                    rc.top,
                    rc.right - rc.left,
                    rc.bottom - rc.top,
                    SWP_NOACTIVATE | SWP_NOZORDER,
                );
            }
        }
    }

    unsafe fn paint(hwnd: HWND) {
        unsafe {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            let mut rc = RECT::default();
            let _ = GetClientRect(hwnd, &mut rc);
            let brush = CreateSolidBrush(rgb(CANVAS));
            FillRect(hdc, &rc, brush);
            let _ = DeleteObject(brush.into());
            // The main window's DPI (the splash sits on the same monitor).
            let dpi = handle(MAIN.load(Ordering::Acquire)).map(|m| GetDpiForWindow(m)).unwrap_or(0);
            let scale = if dpi > 0 { dpi as f64 / 96.0 } else { 1.0 };
            let l = layout(rc.right, rc.bottom, scale);
            if let Some(pixels) = mark_bgra(l.mark_size as u32) {
                let bmi = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: l.mark_size,
                        biHeight: -l.mark_size, // top-down
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                let n = l.mark_size as u32;
                SetDIBitsToDevice(hdc, l.mark_x, l.mark_y, n, n, 0, 0, 0, n, pixels.as_ptr().cast(), &bmi, DIB_RGB_COLORS);
            }
            // system-ui on Windows is Segoe UI; weight 600.
            let font = CreateFontW(
                -l.line_px,
                0,
                0,
                0,
                FW_SEMIBOLD.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                CLEARTYPE_QUALITY,
                (DEFAULT_PITCH.0 | FF_DONTCARE.0) as u32,
                w!("Segoe UI"),
            );
            let previous = SelectObject(hdc, font.into());
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, rgb(INK));
            SetTextCharacterExtra(hdc, l.letter_spacing);
            let text: Vec<u16> = LABEL.encode_utf16().collect();
            let mut extent = SIZE::default();
            let _ = GetTextExtentPoint32W(hdc, &text, &mut extent);
            let mut tm = TEXTMETRICW::default();
            let _ = GetTextMetricsW(hdc, &mut tm);
            // The glyph cell centred in the line box, as CSS line-height does.
            let _ = TextOutW(hdc, (rc.right - extent.cx) / 2, l.line_top + (l.line_px - tm.tmHeight) / 2, &text);
            SelectObject(hdc, previous);
            let _ = DeleteObject(font.into());
            let _ = EndPaint(hwnd, &ps);
            let _ = GdiFlush();
        }
        // Timed once DWM has composed a frame with it (off this thread: the
        // wait is up to a display refresh, and this thread is starting WebView2).
        if PAINTED_MS.get().is_none() && !TIMING.swap(true, Ordering::AcqRel) {
            let spawned = std::thread::Builder::new().name("flowrad-splash-timing".into()).spawn(|| {
                // SAFETY: DwmFlush takes no arguments; it only waits.
                let composed = unsafe { DwmFlush() }.is_ok();
                if composed && on_screen() {
                    if let Some(t0) = T0.get() {
                        let _ = PAINTED_MS.set(t0.elapsed().as_secs_f64() * 1000.0);
                    }
                }
                TIMING.store(false, Ordering::Release);
            });
            if spawned.is_err() {
                TIMING.store(false, Ordering::Release);
            }
        }
    }

    /// The splash exists and its owner is visible and not minimised.
    fn on_screen() -> bool {
        let (Some(main), Some(_)) = (handle(MAIN.load(Ordering::Acquire)), handle(SPLASH.load(Ordering::Acquire))) else {
            return false;
        };
        // SAFETY: read-only window queries.
        unsafe { IsWindowVisible(main).as_bool() && !IsIconic(main).as_bool() }
    }

    pub fn dismiss() {
        DONE.store(true, Ordering::Release);
        if let Some(splash) = handle(SPLASH.load(Ordering::Acquire)) {
            // SAFETY: posting is thread-safe; a window already gone just fails.
            unsafe {
                let _ = PostMessageW(Some(splash), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }

    pub fn dismiss_after(ms: u32) {
        if let Some(splash) = handle(SPLASH.load(Ordering::Acquire)) {
            // SAFETY: as in `dismiss`.
            unsafe {
                let _ = PostMessageW(Some(splash), MSG_GO_AFTER, WPARAM(ms as usize), LPARAM(0));
            }
        }
    }

    pub fn painted_ms() -> Option<f64> {
        PAINTED_MS.get().copied()
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    use objc2::MainThreadMarker;

    /// Runs a closure on the main thread (Tauri's `run_on_main_thread`).
    pub type OnMain = Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

    const LAST_RESORT_MS: u64 = 15_000;
    /// If the window is not on screen yet when the splash goes on, look again
    /// every 10 ms for up to 5 s (as the Windows scout does).
    const RETRY_EVERY_MS: u64 = 10;
    const RETRIES: u32 = 500;

    static T0: OnceLock<Instant> = OnceLock::new();
    static ON_MAIN: OnceLock<OnMain> = OnceLock::new();
    /// On the window (attached, not yet removed).
    static SHOWN: AtomicBool = AtomicBool::new(false);
    /// Dismissed (or turned off): never show it (again).
    static DONE: AtomicBool = AtomicBool::new(false);
    static PAINTED_MS: OnceLock<f64> = OnceLock::new();

    fn now_ms() -> Option<f64> {
        T0.get().map(|t0| t0.elapsed().as_secs_f64() * 1000.0)
    }

    fn on_main(f: impl FnOnce() + Send + 'static) {
        if MainThreadMarker::new().is_some() {
            f();
        } else if let Some(run) = ON_MAIN.get() {
            run(Box::new(f));
        }
    }

    fn after(ms: u64, f: impl FnOnce() + Send + 'static) {
        let _ = std::thread::Builder::new().name("flowrad-splash".into()).spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            f();
        });
    }

    /// Main thread, right before the main window is built: start the clock,
    /// and put the splash on the window the moment tao orders it on screen,
    /// before wry creates the WKWebView (mac_splash.rs `hook_first_show`).
    pub fn arm(t0: Instant) {
        if super::disabled() {
            DONE.store(true, Ordering::Release);
            return;
        }
        let _ = T0.set(t0);
        crate::mac_splash::hook_first_show(shown);
    }

    /// Main thread, inside the window build: the window is on screen and
    /// still holds tao's content view (no WKWebView yet).
    fn shown(ns_window: *mut c_void) {
        if DONE.load(Ordering::Acquire) || !crate::mac_splash::attach_first_show(ns_window) {
            return;
        }
        SHOWN.store(true, Ordering::Release);
        crate::trace("splash on (window shown)");
        // Retries (window not visible yet) are left to `attach`, after the build.
        if time_paint() {
            crate::trace("splash committed");
        }
    }

    /// Main thread, right after the window build returned (built or not).
    pub fn window_built() {
        crate::mac_splash::unhook_first_show();
    }

    /// Main thread, right after the main window and its webview are built:
    /// the splash goes (or moves) over the WKWebView.
    pub fn attach(ns_window: *mut c_void, run_on_main: OnMain) {
        if DONE.load(Ordering::Acquire) || T0.get().is_none() || MainThreadMarker::new().is_none() {
            return;
        }
        let _ = ON_MAIN.set(run_on_main);
        if !crate::mac_splash::attach(ns_window) {
            return;
        }
        SHOWN.store(true, Ordering::Release);
        static TIMER: AtomicBool = AtomicBool::new(false);
        if !TIMER.swap(true, Ordering::AcqRel) {
            after(LAST_RESORT_MS, || go("timeout"));
        }
        if PAINTED_MS.get().is_some() {
            // Already on screen (from the first show): commit its new place.
            crate::mac_splash::flush();
        } else if !time_paint() {
            retry_paint(0);
        }
    }

    /// Main thread: commit the splash to the WindowServer and time it, once.
    /// True when there is nothing left to do (timed, or gone).
    fn time_paint() -> bool {
        if PAINTED_MS.get().is_some() || DONE.load(Ordering::Acquire) {
            return true;
        }
        if !crate::mac_splash::flush() {
            return false;
        }
        if let Some(ms) = now_ms() {
            let _ = PAINTED_MS.set(ms);
        }
        true
    }

    fn retry_paint(tries: u32) {
        if tries >= RETRIES {
            return;
        }
        after(RETRY_EVERY_MS, move || {
            on_main(move || {
                if !time_paint() {
                    retry_paint(tries + 1);
                }
            })
        });
    }

    /// Take the splash off (once), from any thread.
    pub fn go(by: &'static str) {
        if !SHOWN.load(Ordering::Acquire) || DONE.swap(true, Ordering::AcqRel) {
            // Not on yet (or off): it must not come on afterwards either.
            DONE.store(true, Ordering::Release);
            return;
        }
        on_main(move || {
            let Some(stale) = crate::mac_splash::remove() else { return };
            SHOWN.store(false, Ordering::Release);
            if crate::bench_on() {
                crate::bench_emit(
                    "FLOWRAD_SPLASH",
                    &serde_json::json!({
                        "platform": "macos",
                        "paintedMs": PAINTED_MS.get(),
                        "dismissedMs": now_ms(),
                        "dismissedBy": by,
                        "staleViews": stale,
                    }),
                );
            }
        });
    }

    pub fn dismiss_after(ms: u32) {
        if SHOWN.load(Ordering::Acquire) {
            after(ms as u64, || go("load"));
        }
    }

    pub fn painted_ms() -> Option<f64> {
        PAINTED_MS.get().copied()
    }
}

/// Call on the main thread right before the main window is built. Windows:
/// show the native splash on the main window as soon as it is on screen.
/// macOS: start its clock (it goes on in `attach`).
pub fn arm(t0: std::time::Instant, title: &str) {
    #[cfg(windows)]
    imp::arm(t0, title);
    #[cfg(target_os = "macos")]
    {
        mac::arm(t0);
        let _ = title;
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = (t0, title, disabled());
}

/// macOS: the main window's build returned (the first-show hook goes).
#[cfg(target_os = "macos")]
pub fn window_built() {
    mac::window_built();
}

/// macOS: put the splash over the main window (`ns_window`). Main thread,
/// right after the window and its webview are built. `run_on_main` runs a
/// closure on the main thread (the dismissal comes from other threads).
#[cfg(target_os = "macos")]
pub fn attach(
    ns_window: *mut std::ffi::c_void,
    run_on_main: impl Fn(Box<dyn FnOnce() + Send>) + Send + Sync + 'static,
) {
    mac::attach(ns_window, Box::new(run_on_main));
}

/// The page has painted its own splash: the native one can go. Any thread.
pub fn dismiss() {
    #[cfg(windows)]
    imp::dismiss();
    #[cfg(target_os = "macos")]
    mac::go("page");
}

/// The page has loaded: if it never reports a paint, go after `ms` anyway.
pub fn dismiss_after(ms: u32) {
    #[cfg(windows)]
    imp::dismiss_after(ms);
    #[cfg(target_os = "macos")]
    mac::dismiss_after(ms);
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = ms;
}

/// When the native splash was first on screen, ms since process start
/// (Windows: DWM composed it; macOS: committed to the WindowServer for a
/// visible window). None: no native splash (yet, or on this platform).
pub fn painted_ms() -> Option<f64> {
    #[cfg(windows)]
    return imp::painted_ms();
    #[cfg(target_os = "macos")]
    return mac::painted_ms();
    #[cfg(not(any(windows, target_os = "macos")))]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The CSS of `.boot` at 100 % on the default 1440 x 900 window.
    #[test]
    fn layout_matches_the_page_splash() {
        let l = layout(1440, 900, 1.0);
        // Column of 56 + 20 + 12 = 88 px, centred above 8 px of padding.
        assert_eq!(l, Layout { mark_x: 692, mark_y: 402, mark_size: 56, line_top: 478, line_px: 12, letter_spacing: 2 });
        // 150 %: everything in physical px.
        let l = layout(2160, 1350, 1.5);
        assert_eq!((l.mark_size, l.line_px, l.letter_spacing), (84, 18, 3));
        assert_eq!(l.mark_x, (2160 - 84) / 2);
        assert_eq!(l.line_top - l.mark_y, 114);
        // A nonsense scale falls back to 100 %.
        assert_eq!(layout(1440, 900, 0.0), layout(1440, 900, 1.0));
    }

    #[test]
    fn mark_is_composited_over_the_canvas() {
        for size in [56u32, 70, 84, 112, 140] {
            let px = mark_bgra(size).expect("decode");
            assert_eq!(px.len(), (size * size * 4) as usize);
            // Corner: transparent in the PNG, so exactly the canvas (BGRA).
            assert_eq!(&px[..4], &[CANVAS[2], CANVAS[1], CANVAS[0], 255]);
            // Opaque everywhere.
            assert!(px.chunks(4).all(|p| p[3] == 255));
        }
        // The owl's face is light, its frame dark green: both present.
        let px = mark_bgra(56).unwrap();
        assert!(px.chunks(4).any(|p| p[0] > 230 && p[1] > 230 && p[2] > 230));
        assert!(px.chunks(4).any(|p| p[1] > p[2] + 30 && p[1] > p[0]));
    }

    /// The native splash draws the same mark as the page's splash.
    #[test]
    fn mark_is_the_one_in_index_html() {
        use base64::Engine;
        let html = include_str!("../../index.html");
        let start = html.find("data:image/png;base64,").expect("inline PNG") + "data:image/png;base64,".len();
        let end = start + html[start..].find('"').unwrap();
        let png = base64::engine::general_purpose::STANDARD.decode(&html[start..end]).unwrap();
        assert!(png == MARK_PNG, "icons/splash-owl.png differs from the PNG in desktop/index.html");
        // Same label, same colours as the page's CSS.
        assert!(html.contains("color: #a9c4b9") && html.contains("background: #0b0d10"));
        assert!(html.contains("<span>FlowRad Viewer</span>") && html.contains("text-transform: uppercase"));
        assert_eq!(LABEL, "FlowRad Viewer".to_uppercase());
    }
}
