//! Phase 2 (docs/NATIVE_RENDERER.md): the native renderer. A wgpu surface is
//! drawn in the window UNDER a transparent WebView2, behind `FLOWRAD_NATIVE=1`.
//!
//! The webview keeps all chrome and input; it reports the rectangles of its
//! viewports ("cells", CSS px of the page) and Rust draws each cell's slice
//! with the GPU. Where the page is transparent the native pixels show through;
//! everything the page draws (toolbar, overlays, menus, annotations) sits on
//! top.
//!
//! - P2.0: the surface, transparency, one test image (spike view).
//! - P2.1: decoded slices from the Rust image core (image_store.rs), the first
//!   paint before WebView2 loads.
//! - P2.2: every layout cell is a native viewport with its own view (slice,
//!   window/level, zoom, pan, rotate, flip, invert), one draw per cell with
//!   its own uniforms and texture, scissored to the cell. The image ↔ cell
//!   transform (native_view.rs) is returned with every view so the page can
//!   draw overlays in image coordinates.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::image_store::{self, ImageStore, Slice};
use crate::native_view::{Transform, View, ViewPatch};

/// P2.6 cutover: the native renderer is the default on Windows and macOS
/// (DX12 / Metal); FLOWRAD_NATIVE=0 turns it off (the JS renderer, as before
/// Phase 2). Linux stays on the JS path unless FLOWRAD_NATIVE=1 (WebKitGTK
/// transparency over a native surface is not validated). Without a usable
/// GPU adapter the init fails and the app falls back to JS by itself.
pub fn enabled() -> bool {
    match crate::flowrad_env("NATIVE").as_deref() {
        Ok("0") => false,
        Ok("1") => true,
        _ => cfg!(any(target_os = "windows", target_os = "macos")),
    }
}

/// When the GPU device exists. Windows: only while a study needs it. The
/// D3D12 device, the driver's user-mode heaps, the swap chain and pipelines
/// were built at launch and held for the whole session, study or not (HP
/// 0.8.2: 1,038 ms of warm-up, held by a 358 MB empty app). Now they are
/// built when a study is about to open (a study on the command line, the
/// Open dialog, a drag over the window, a history / PACS open) and released
/// once no viewport has used them for `GPU_IDLE_RELEASE` (study closed,
/// dialog cancelled). macOS / Linux keep the launch-time device.
/// `FLOWRAD_GPU_WARM=eager|lazy` overrides, for A/B runs.
pub fn lazy_gpu() -> bool {
    match crate::flowrad_env("GPU_WARM").as_deref() {
        Ok("eager") => false,
        Ok("lazy") => true,
        _ => cfg!(target_os = "windows"),
    }
}

/// Lazy mode: how long the GPU may sit unused with no viewport before it is
/// released (well inside the close bench's 30 s sample, well past the gap
/// between a close and the next open's first native call).
pub const GPU_IDLE_RELEASE: std::time::Duration = std::time::Duration::from_secs(15);

/// A viewport rectangle in CSS pixels of the page (its top-left origin is
/// the window's client-area origin: the webview fills the window).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Default)]
pub struct Cell {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// A layout cell from the page: its id (the layout cell key) and rectangle.
#[derive(Clone, Debug, Deserialize)]
pub struct CellRect {
    pub id: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeStatus {
    pub enabled: bool,
    pub ready: bool,
    pub adapter: Option<String>,
    pub backend: Option<String>,
    pub error: Option<String>,
    pub init_ms: Option<f64>,
    /// macOS: of `init_ms`, time spent waiting for the main thread to create
    /// the surface (it is busy while WKWebView loads the page).
    pub surface_wait_ms: Option<f64>,
    /// macOS: MB of GPU resources the Metal device holds now, and right after
    /// init (the empty app): what a study adds on the GPU, and what a close
    /// gives back (with the close report's figure).
    pub gpu_allocated_mb: Option<f64>,
    pub gpu_allocated_init_mb: Option<f64>,
    /// Last frame: CPU time to record + submit (not GPU time).
    pub last_frame_ms: Option<f64>,
    pub frames: u64,
    /// Window client-area origin on screen, physical px (for the e2e grab).
    pub client_origin: Option<(i32, i32)>,
    pub scale: Option<f64>,
    /// Native viewports alive.
    pub cells: usize,
    /// The GPU is built on demand (`lazy_gpu`), not at launch: the page asks
    /// for it when a study is about to open instead of at start-up.
    pub lazy: bool,
    /// Last device build, ms (lazy mode: the one a study open overlapped).
    pub warm_ms: Option<f64>,
    /// Times the GPU was released for being idle (lazy mode).
    pub releases: u32,
}

const TEST_SIZE: u32 = 512;
/// The spike view's single cell.
pub const SPIKE: &str = "spike";

/// One cell's GPU side: its uniforms and the image on screen.
struct CellGpu {
    uniforms: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    /// (path, GPU copy) of the image uploaded, None = the test image.
    image: Option<(PathBuf, CellImage)>,
    dims: (usize, usize),
    /// Changes whenever the cell's GPU image is (re)written (`next_gen`), so
    /// a frame's signature (`frame_signature`) sees new pixels under an
    /// unchanged path (3D frames).
    generation: u64,
}

/// A fresh value for `CellGpu::generation`.
fn next_gen() -> u64 {
    static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// A cell's image on the GPU.
enum CellImage {
    /// A grey slice: its 16-bit values in a read-only storage buffer, two
    /// per word, read by the cell shader. A buffer, not a texture, so that on
    /// a cache-coherent UMA adapter (WARP, integrated GPUs) the slice can be
    /// written straight into memory the GPU reads, with no staging copy
    /// (native_uma.rs); elsewhere wgpu uploads it (`slice_buffer`).
    Slice(wgpu::Buffer),
    /// An RGBA8 colour frame (3D), drawn with the colour pipeline.
    Rgba(wgpu::Texture),
}

impl CellGpu {
    fn rgba(&self) -> bool {
        matches!(self.image, Some((_, CellImage::Rgba(_))))
    }
}

/// Bytes of the storage buffer holding a `cols` × `rows` slice: two per
/// value, rounded up to whole 32-bit words (what the shader reads, and
/// wgpu's copy alignment).
fn slice_buffer_size(cols: usize, rows: usize) -> u64 {
    ((cols * rows * 2) as u64).div_ceil(4).max(1) * 4
}

/// A slice's values as the bytes of its storage buffer (little-endian i16,
/// zero-padded to `slice_buffer_size`).
fn slice_bytes(data: &[i16]) -> std::borrow::Cow<'_, [u8]> {
    // SAFETY: i16 is plain old data; the bytes borrow `data`.
    let raw = unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, std::mem::size_of_val(data)) };
    if raw.len() % 4 == 0 && !raw.is_empty() && cfg!(target_endian = "little") {
        std::borrow::Cow::Borrowed(raw)
    } else {
        let mut v: Vec<u8> = data.iter().flat_map(|x| x.to_le_bytes()).collect();
        v.resize(v.len().div_ceil(4).max(1) * 4, 0);
        std::borrow::Cow::Owned(v)
    }
}

fn slice_buffer(device: &wgpu::Device, cols: usize, rows: usize) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("slice"),
        size: slice_buffer_size(cols, rows),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

/// P2.4: a plane (or slab) of the Rust volume (volume.rs) as a cell's source.
#[derive(Clone, Copy, Debug)]
struct PlaneSrc {
    key: u64,
    plane: crate::volume::Plane,
    slab: crate::volume::Slab,
    mm: f64,
    depth: usize,
    max_dim: usize,
}

/// One viewport.
struct CellState {
    rect: Cell,
    series: Vec<PathBuf>,
    /// When set, the cell shows this volume plane instead of `series`.
    plane: Option<PlaneSrc>,
    view: View,
    gpu: Option<CellGpu>,
}

struct Gpu {
    /// Shared with the macOS presenter, which waits for a drawable without
    /// the GPU lock (`present_latest`).
    surface: Arc<wgpu::Surface<'static>>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    /// P2.5: colour frames (3D): RGBA8 texture, no window / level.
    pipeline_rgba: wgpu::RenderPipeline,
    layout_rgba: wgpu::BindGroupLayout,
    /// The test image (spike / a cell before its first slice), as a slice buffer.
    test_image: wgpu::Buffer,
    /// macOS: the surface is configured 1×1 since a study closed
    /// (`park_surface`); the next frame restores `config` first.
    parked: bool,
    /// Slices are written straight into write-back system memory the shader
    /// reads (Windows, cache-coherent UMA: WARP, integrated GPUs), not
    /// staged and copied: see native_uma.rs.
    #[cfg_attr(not(windows), allow(dead_code))]
    direct_slices: bool,
    /// macOS: the signature of the frame last drawn (`frame_signature`),
    /// what the surface shows or is about to; None when it must be drawn.
    #[cfg(target_os = "macos")]
    drawn: Option<u64>,
    /// macOS: frames are drawn here, then copied onto a drawable by the
    /// presenter (`draw`). Window-sized; dropped when a study closes.
    #[cfg(target_os = "macos")]
    offscreen: Option<wgpu::Texture>,
    /// macOS: the surface is configured to `config` by the presenter before
    /// its next drawable (set by a resize, or a frame after a park).
    #[cfg(target_os = "macos")]
    needs_configure: bool,
}

/// macOS: frame generations drawn and presented (`draw`, `present_latest`).
#[cfg(target_os = "macos")]
#[derive(Default)]
struct Presented {
    drawn: u64,
    shown: u64,
    /// The last present's wait for a drawable, ms.
    acquire_ms: f64,
}

#[derive(Default)]
pub struct Native {
    gpu: Mutex<Option<Gpu>>,
    status: Mutex<NativeStatus>,
    cells: Mutex<HashMap<String, CellState>>,
    /// P2.1: decoded slices, byte-budgeted, shared by every window.
    pub store: std::sync::OnceLock<Arc<ImageStore>>,
    /// Serialises init (start-up paint and the page's native_init can race:
    /// two surfaces on one window would fail).
    init_lock: tauri::async_runtime::Mutex<()>,
    /// Last time the GPU was created or drew a frame (lazy mode's idle release).
    last_use: Mutex<Option<Instant>>,
    /// The main window's scale factor, kept from its own events (macOS reads
    /// it here for a frame, see lib.rs `frame_scale`).
    window_scale: Mutex<Option<f64>>,
    /// macOS: the presenter's state and its wake-up (`draw`).
    #[cfg(target_os = "macos")]
    present: Mutex<Presented>,
    #[cfg(target_os = "macos")]
    present_cv: parking_lot::Condvar,
    /// macOS: held by whoever acquires, configures or parks the surface;
    /// always taken before the GPU lock.
    #[cfg(target_os = "macos")]
    surface_lock: Mutex<()>,
    #[cfg(target_os = "macos")]
    presenter: std::sync::OnceLock<()>,
}

pub type Shared = Arc<Native>;

/// What a study held when it was closed (`close_all`), MB.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedReport {
    pub cells: usize,
    pub cell_textures_mb: f64,
    pub store_mb: f64,
    pub store_slices: usize,
    /// A reformat volume still alive after close (its views free it).
    pub volume_mb: f64,
    /// wgpu's GPU allocator after the close (D3D12): live, and reserved in blocks.
    pub gpu_allocated_mb: Option<f64>,
    pub gpu_reserved_mb: Option<f64>,
    /// macOS: Metal's count with the cells dropped but before the queue was
    /// flushed (what the flush below gives back: textures an upload still
    /// referenced, staging buffers).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_allocated_unflushed_mb: Option<f64>,
}

/// The 16-bit test image: a horizontal ramp with concentric rings, so window
/// / level visibly changes contrast and an off-by-one in the upload shows.
pub fn test_image(size: u32) -> Vec<i16> {
    let n = size as usize;
    let mut px = vec![0i16; n * n];
    let c = n as f32 / 2.0;
    for y in 0..n {
        for x in 0..n {
            let ramp = x as f32 / (n - 1) as f32;
            let r = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let ring = if (r as usize / 24) % 2 == 0 { 0.0 } else { 0.15 };
            px[y * n + x] = (((ramp * 0.85) + ring).min(1.0) * 32767.0) as i16;
        }
    }
    px
}

/// Uniforms per cell (std140: five vec4).
///   rect   x, y, w, h of the cell, physical px of the surface
///   wl     centre, width (modality units), surface w, h
///   xf     scale (physical px per image px), centre x, y (physical px, in the cell), invert
///   rot    cos, sin, flip x, flip y
///   dims   cols, rows, -, -
const SHADER: &str = r#"
struct U { rect: vec4<f32>, wl: vec4<f32>, xf: vec4<f32>, rot: vec4<f32>, dims: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
// The slice: 16-bit signed values, two per word, row-major (dims.x per row).
@group(0) @binding(1) var<storage, read> img: array<u32>;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var corners = array<vec2<f32>, 6>(vec2(0.,0.), vec2(1.,0.), vec2(0.,1.), vec2(0.,1.), vec2(1.,0.), vec2(1.,1.));
  let c = corners[i];
  let px = u.rect.xy + c * u.rect.zw;
  var o: VOut;
  o.pos = vec4(px.x / u.wl.z * 2.0 - 1.0, 1.0 - px.y / u.wl.w * 2.0, 0.0, 1.0);
  o.uv = c;
  return o;
}

@fragment fn fs(v: VOut) -> @location(0) vec4<f32> {
  // Cell px -> image px: the inverse of native_view.rs Transform::to_cell.
  let d = v.uv * u.rect.zw - u.xf.yz;
  let f = vec2(u.rot.x * d.x + u.rot.y * d.y, -u.rot.y * d.x + u.rot.x * d.y);
  let q = vec2(f.x * u.rot.z, f.y * u.rot.w) / u.xf.x + u.dims.xy * 0.5;
  if (q.x < 0.0 || q.y < 0.0 || q.x >= u.dims.x || q.y >= u.dims.y) { return vec4(0.0, 0.0, 0.0, 1.0); }
  let p = vec2<u32>(q);
  let i = p.y * u32(u.dims.x) + p.x;
  let w = img[i >> 1u];
  // Low half for even i, high half for odd; sign-extend from 16 bits.
  let s = f32(bitcast<i32>(select(w << 16u, w, (i & 1u) == 1u)) >> 16u);
  let lo = u.wl.x - u.wl.y * 0.5;
  var g = clamp((s - lo) / max(u.wl.y, 1.0), 0.0, 1.0);
  if (u.xf.w > 0.5) { g = 1.0 - g; }
  return vec4(g, g, g, 1.0);
}
"#;

/// P2.5: the colour pipeline (3D frames): same geometry, no window / level.
const SHADER_RGBA: &str = r#"
struct U { rect: vec4<f32>, wl: vec4<f32>, xf: vec4<f32>, rot: vec4<f32>, dims: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var img: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var corners = array<vec2<f32>, 6>(vec2(0.,0.), vec2(1.,0.), vec2(0.,1.), vec2(0.,1.), vec2(1.,0.), vec2(1.,1.));
  let c = corners[i];
  let px = u.rect.xy + c * u.rect.zw;
  var o: VOut;
  o.pos = vec4(px.x / u.wl.z * 2.0 - 1.0, 1.0 - px.y / u.wl.w * 2.0, 0.0, 1.0);
  o.uv = c;
  return o;
}

@fragment fn fs(v: VOut) -> @location(0) vec4<f32> {
  let d = v.uv * u.rect.zw - u.xf.yz;
  let f = vec2(u.rot.x * d.x + u.rot.y * d.y, -u.rot.y * d.x + u.rot.x * d.y);
  let q = vec2(f.x * u.rot.z, f.y * u.rot.w) / u.xf.x + u.dims.xy * 0.5;
  if (q.x < 0.0 || q.y < 0.0 || q.x >= u.dims.x || q.y >= u.dims.y) { return vec4(0.0, 0.0, 0.0, 1.0); }
  return vec4(textureLoad(img, vec2<i32>(q), 0).rgb, 1.0);
}
"#;

/// What the page gets back for a cell after any change.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShowResult {
    pub index: usize,
    pub count: usize,
    pub cached: bool,
    pub decode_ms: f64,
    pub frame_ms: f64,
    /// Of `frame_ms`: waiting for the surface's next drawable / swap-chain image.
    pub acquire_ms: f64,
    pub total_ms: f64,
    pub rows: usize,
    pub cols: usize,
    pub window: (f32, f32),
    pub view: View,
    /// Image ↔ cell (CSS px), for overlays.
    pub transform: Transform,
    /// The file's own window (for "reset").
    pub default_window: Option<(f64, f64)>,
    /// Largest value in the image (the page derives "is anything visible").
    pub data_max: i16,
}

/// A region in image pixel coordinates (col, row).
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RoiShape {
    /// Axis-aligned in image space: two opposite corners.
    Rect { a: (f32, f32), b: (f32, f32) },
    /// Axis-aligned ellipse inscribed in the box of two corners.
    Ellipse { a: (f32, f32), b: (f32, f32) },
    /// Closed polygon (freehand).
    Polygon { points: Vec<(f32, f32)> },
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoiStats {
    pub mean: f64,
    pub sd: f64,
    pub min: f64,
    pub max: f64,
    pub pixels: usize,
    pub area_mm2: f64,
}

fn inside_polygon(pts: &[(f32, f32)], x: f32, y: f32) -> bool {
    let mut inside = false;
    let mut j = pts.len().wrapping_sub(1);
    for i in 0..pts.len() {
        let (xi, yi) = pts[i];
        let (xj, yj) = pts[j];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi + f32::EPSILON) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Pixels whose centre falls inside the shape.
pub fn roi_stats(s: &Slice, shape: &RoiShape) -> RoiStats {
    let (x0, y0, x1, y1) = match shape {
        RoiShape::Rect { a, b } | RoiShape::Ellipse { a, b } => (a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1)),
        RoiShape::Polygon { points } => points.iter().fold((f32::MAX, f32::MAX, f32::MIN, f32::MIN), |(a, b, c, d), p| (a.min(p.0), b.min(p.1), c.max(p.0), d.max(p.1))),
    };
    let cmin = x0.floor().max(0.0) as usize;
    let rmin = y0.floor().max(0.0) as usize;
    let cmax = (x1.ceil() as usize).min(s.cols);
    let rmax = (y1.ceil() as usize).min(s.rows);
    let (cx, cy, rx, ry) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0, ((x1 - x0) / 2.0).max(1e-6), ((y1 - y0) / 2.0).max(1e-6));
    let (mut n, mut sum, mut sum2, mut lo, mut hi) = (0usize, 0f64, 0f64, f64::MAX, f64::MIN);
    for r in rmin..rmax {
        for c in cmin..cmax {
            let (px, py) = (c as f32 + 0.5, r as f32 + 0.5);
            let inside = match shape {
                RoiShape::Rect { .. } => px >= x0 && px <= x1 && py >= y0 && py <= y1,
                RoiShape::Ellipse { .. } => ((px - cx) / rx).powi(2) + ((py - cy) / ry).powi(2) <= 1.0,
                RoiShape::Polygon { points } => inside_polygon(points, px, py),
            };
            if inside {
                let v = s.data[r * s.cols + c] as f64;
                n += 1;
                sum += v;
                sum2 += v * v;
                lo = lo.min(v);
                hi = hi.max(v);
            }
        }
    }
    let mean = if n > 0 { sum / n as f64 } else { 0.0 };
    let sd = if n > 1 { ((sum2 - sum * sum / n as f64) / (n as f64 - 1.0)).max(0.0).sqrt() } else { 0.0 };
    RoiStats {
        mean,
        sd,
        min: if n > 0 { lo } else { 0.0 },
        max: if n > 0 { hi } else { 0.0 },
        pixels: n,
        area_mm2: n as f64 * s.spacing[0] * s.spacing[1],
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Render3dResult {
    pub w: usize,
    pub h: usize,
    pub render_ms: f64,
    pub frame_ms: f64,
    /// Brightest channel value (0–255) in the frame: "is anything drawn".
    pub max_lum: u8,
}

/// A window over the slice's data range, for files without one.
fn data_window(s: &Slice) -> (f64, f64) {
    let (lo, hi) = s.data.iter().fold((i16::MAX, i16::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    let (lo, hi) = (lo as f64, hi as f64);
    ((lo + hi) / 2.0, (hi - lo).max(1.0))
}

impl Native {
    pub fn status(&self) -> NativeStatus {
        let mut s = self.status.lock().clone();
        s.enabled = enabled();
        s.lazy = lazy_gpu();
        s.warm_ms = *LAST_WARM_MS.lock();
        s.cells = self.cells.lock().len();
        #[cfg(target_os = "macos")]
        if let Some(gpu) = self.gpu.lock().as_ref() {
            s.gpu_allocated_mb = metal_allocated_mb(&gpu.device);
        }
        s
    }

    pub fn store(&self) -> Arc<ImageStore> {
        self.store.get_or_init(|| Arc::new(ImageStore::new(image_store::budget_from_env()))).clone()
    }

    /// Create the surface on the window and the device. Idempotent. Async:
    /// it runs inside Tauri's async runtime (a blocking wait there panics).
    pub async fn init(&self, window: &tauri::WebviewWindow) -> NativeStatus {
        let _serial = self.init_lock.lock().await;
        if self.gpu.lock().is_some() || !enabled() {
            return self.status();
        }
        let started = Instant::now();
        match create_gpu(window).await {
            Ok((gpu, adapter, backend)) => {
                *self.gpu.lock() = Some(gpu);
                *self.last_use.lock() = Some(Instant::now());
                // Read before taking the status lock (render takes gpu, then status).
                #[cfg(target_os = "macos")]
                let init_metal = self.gpu.lock().as_ref().and_then(|g| metal_allocated_mb(&g.device));
                let mut s = self.status.lock();
                s.ready = true;
                s.adapter = Some(adapter);
                s.backend = Some(backend);
                s.error = None;
                s.init_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
                s.surface_wait_ms = SURFACE_WAIT_MS.lock().take();
                #[cfg(target_os = "macos")]
                {
                    s.gpu_allocated_init_mb = init_metal;
                }
            }
            Err(e) => self.status.lock().error = Some(e),
        }
        self.status()
    }

    pub fn has_gpu(&self) -> bool {
        self.gpu.lock().is_some()
    }

    /// The GPU should be (re)built before drawing: not there, and the last
    /// attempt did not fail (a failed init is not retried on every call; the
    /// page has fallen back to the JS renderer then).
    pub fn needs_gpu(&self) -> bool {
        enabled() && self.gpu.lock().is_none() && self.status.lock().error.is_none()
    }

    /// Lazy mode: drop the device, swap chain and pipelines when no viewport
    /// exists and nothing has drawn or asked for the GPU for `idle`. Returns
    /// true when it released them; the next study rebuilds them (`init`).
    pub fn release_gpu_if_idle(&self, idle: std::time::Duration) -> bool {
        // Never while an init is running (it is about to hand out a GPU).
        let Ok(_serial) = self.init_lock.try_lock() else { return false };
        if !self.cells.lock().is_empty() || self.last_use.lock().is_some_and(|t| t.elapsed() < idle) {
            return false;
        }
        let Some(gpu) = self.gpu.lock().take() else { return false };
        flush_and_wait(&gpu);
        drop(gpu);
        let mut s = self.status.lock();
        s.ready = false;
        s.releases += 1;
        true
    }

    pub fn resize(&self, width: u32, height: u32) {
        if let Some(gpu) = self.gpu.lock().as_mut() {
            if width > 0 && height > 0 && (gpu.config.width != width || gpu.config.height != height) {
                gpu.config.width = width;
                gpu.config.height = height;
                // Parked (no study): the next frame configures the new size.
                // macOS: the presenter does, before its next drawable (it may
                // be waiting for one now); the next frame is drawn in full.
                #[cfg(target_os = "macos")]
                if !gpu.parked {
                    gpu.needs_configure = true;
                    gpu.drawn = None;
                }
                #[cfg(not(target_os = "macos"))]
                if !gpu.parked {
                    gpu.surface.configure(&gpu.device, &gpu.config);
                }
            }
        }
    }

    /// P2.5: a 3D rendering (volume rendering / MIP of the built volume,
    /// ray-cast in Rust on every core) drawn into cell `id` as an RGBA frame:
    /// no PNG encode, no browser decode, no copy in WebView2's GPU process.
    #[allow(clippy::too_many_arguments)]
    pub fn show_render3d(
        &self,
        id: &str,
        key: u64,
        mode: crate::render3d::Mode,
        yaw: f32,
        pitch: f32,
        zoom: f32,
        center: f32,
        width: f32,
        size: usize,
        fast: bool,
        scale: f64,
    ) -> Result<Render3dResult, String> {
        let started = Instant::now();
        let v = crate::volume::current(key).ok_or("the volume is not built")?;
        let f = crate::render3d::render(&v, mode, yaw, pitch, zoom, center, width, size.clamp(32, 2048), fast);
        let render_ms = started.elapsed().as_secs_f64() * 1000.0;
        let max_lum = f.rgb.iter().copied().max().unwrap_or(0);
        {
            let mut cells = self.cells.lock();
            let c = cells.entry(id.to_string()).or_insert(CellState { rect: Cell::default(), series: vec![], plane: None, view: View::default(), gpu: None });
            c.series.clear();
            c.plane = None;
            c.view = View::default();
        }
        self.upload_rgba(id, f.w, f.h, &f.rgb)?;
        let frame_ms = self.draw(scale, true)?;
        Ok(Render3dResult { w: f.w, h: f.h, render_ms, frame_ms, max_lum })
    }

    fn upload_rgba(&self, id: &str, w: usize, h: usize, rgb: &[u8]) -> Result<(), String> {
        let guard = self.gpu.lock();
        let gpu = guard.as_ref().ok_or("native renderer not initialised")?;
        let mut cells = self.cells.lock();
        let c = cells.get_mut(id).ok_or("no such viewport")?;
        let cg = c.gpu.get_or_insert_with(|| new_cell_gpu(gpu, &gpu.test_image));
        let size = wgpu::Extent3d { width: w as u32, height: h as u32, depth_or_array_layers: 1 };
        let was_rgba = cg.rgba();
        let reuse = match cg.image.take() {
            Some((_, CellImage::Rgba(t))) if t.width() == size.width && t.height() == size.height => Some(t),
            _ => None,
        };
        let fresh = reuse.is_none();
        let texture = reuse.unwrap_or_else(|| {
            gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("3d frame"),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            })
        });
        let rgba: Vec<u8> = rgb.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect();
        gpu.queue.write_texture(
            texture.as_image_copy(),
            &rgba,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size.width * 4), rows_per_image: Some(size.height) },
            size,
        );
        if fresh || !was_rgba {
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            cg.bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("3d"),
                layout: &gpu.layout_rgba,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: cg.uniforms.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view) },
                ],
            });
        }
        cg.image = Some((PathBuf::from("3d"), CellImage::Rgba(texture)));
        cg.dims = (w, h);
        cg.generation = next_gen();
        Ok(())
    }

    pub fn set_window_facts(&self, origin: (i32, i32), scale: f64) {
        self.set_window_scale(scale);
        let mut s = self.status.lock();
        s.client_origin = Some(origin);
        s.scale = Some(scale);
    }

    /// The main window's scale factor changed (or was read on its thread).
    pub fn set_window_scale(&self, scale: f64) {
        if scale > 0.0 {
            *self.window_scale.lock() = Some(scale);
        }
    }

    /// The main window's last known scale factor (None until it is known).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn window_scale(&self) -> Option<f64> {
        *self.window_scale.lock()
    }

    // ───────────── layout ─────────────

    /// The page's cells, all of them: cells not listed are dropped (their
    /// textures freed). New cells start empty (black) until given a series.
    pub fn set_layout(&self, rects: Vec<CellRect>) {
        let mut cells = self.cells.lock();
        cells.retain(|id, _| rects.iter().any(|r| &r.id == id));
        for r in rects {
            let rect = Cell { x: r.x, y: r.y, w: r.w, h: r.h };
            cells
                .entry(r.id)
                .and_modify(|c| c.rect = rect)
                .or_insert(CellState { rect, series: vec![], plane: None, view: View::default(), gpu: None });
        }
    }

    /// Spike (P2.0): one cell showing the test image.
    pub fn set_cells(&self, rects: Vec<Cell>) {
        let first = rects.first().copied().unwrap_or_default();
        let mut cells = self.cells.lock();
        let c = cells.entry(SPIKE.to_string()).or_insert(CellState {
            rect: first,
            series: vec![],
            plane: None,
            view: View { wl: (16384.0, 32767.0), ..View::default() },
            gpu: None,
        });
        c.rect = first;
    }

    /// Spike: window / level of the spike cell.
    pub fn set_wl(&self, center: f32, width: f32) {
        if let Some(c) = self.cells.lock().get_mut(SPIKE) {
            c.view.wl = (center, width.max(1.0));
        }
    }

    // ───────────── series and views ─────────────

    /// Show `paths` (display order) in cell `id` at `index`, with the file's window.
    /// `rect`: the cell's rectangle when the page knows it (a viewport's
    /// first series), so this frame draws it in place.
    pub fn set_series(&self, id: &str, paths: Vec<PathBuf>, index: usize, rect: Option<Cell>, scale: f64) -> Result<ShowResult, String> {
        {
            let mut cells = self.cells.lock();
            let c = cells.entry(id.to_string()).or_insert(CellState { rect: Cell::default(), series: vec![], plane: None, view: View::default(), gpu: None });
            if let Some(r) = rect.filter(|r| r.w > 0.0 && r.h > 0.0) {
                c.rect = r;
            }
            c.series = paths;
            c.plane = None;
            c.view = View { index: index.min(c.series.len().saturating_sub(1)), ..View::default() };
        }
        self.show(id, None, true, scale, true)
    }

    /// A streaming series grew: append `paths` to cell `id`'s list, keeping
    /// its view (slice, window, zoom). No decode, upload or draw: the shown
    /// slice is unchanged, so nothing goes back to the store. `from` is the
    /// length the caller last sent; on any mismatch (the cell is gone, shows
    /// a plane, or the list was rebuilt) it returns `None` and the caller
    /// re-sends the whole series. Returns the new count.
    pub fn append_series(&self, id: &str, from: usize, paths: Vec<PathBuf>) -> Option<usize> {
        let mut cells = self.cells.lock();
        let c = cells.get_mut(id)?;
        if c.plane.is_some() || c.series.len() != from {
            return None;
        }
        c.series.extend(paths);
        Some(c.series.len())
    }

    /// P2.4: show a plane (or slab) of the built volume `key` in cell `id`.
    /// Window / level, zoom, pan etc. apply as for a stack; the index pages
    /// along the plane's axis. `max_dim`: output resolution (long side).
    #[allow(clippy::too_many_arguments)]
    pub fn set_plane(
        &self,
        id: &str,
        key: u64,
        plane: crate::volume::Plane,
        index: usize,
        slab: crate::volume::Slab,
        mm: f64,
        max_dim: usize,
        wl: Option<(f32, f32)>,
        scale: f64,
    ) -> Result<ShowResult, String> {
        let v = crate::volume::current(key).ok_or("the volume is not built")?;
        let depth = match plane {
            crate::volume::Plane::Axial => v.dims[2],
            crate::volume::Plane::Coronal => v.dims[1],
            crate::volume::Plane::Sagittal => v.dims[0],
        };
        let reset = {
            let mut cells = self.cells.lock();
            let c = cells.entry(id.to_string()).or_insert(CellState { rect: Cell::default(), series: vec![], plane: None, view: View::default(), gpu: None });
            let fresh = c.plane.map(|p| p.key != key || p.plane != plane).unwrap_or(true);
            c.series.clear();
            c.plane = Some(PlaneSrc { key, plane, slab, mm, depth, max_dim: max_dim.clamp(64, 2048) });
            c.view.index = index.min(depth.saturating_sub(1));
            if let Some(wl) = wl {
                c.view.wl = (wl.0, wl.1.max(1.0));
            }
            fresh && wl.is_none()
        };
        self.show(id, None, reset, scale, true)
    }

    /// Apply a view change (any of slice, window, zoom, pan, rotation, flip, invert).
    pub fn update_view(&self, id: &str, patch: ViewPatch, scale: f64) -> Result<ShowResult, String> {
        self.show(id, Some(patch), false, scale, false)
    }

    /// Scroll by `delta` slices (clamped).
    pub fn scroll(&self, id: &str, delta: i64, scale: f64) -> Result<ShowResult, String> {
        let at = {
            let cells = self.cells.lock();
            let c = cells.get(id).ok_or("no such viewport")?;
            let n = c.plane.map(|p| p.depth).unwrap_or(c.series.len());
            if n == 0 {
                return Err("no series in this viewport".into());
            }
            (c.view.index as i64 + delta).clamp(0, n as i64 - 1) as usize
        };
        self.show(id, Some(ViewPatch { index: Some(at), ..Default::default() }), false, scale, false)
    }

    /// Free a cell's texture and series (viewport closed or switched to JS).
    pub fn close_cell(&self, id: &str) {
        self.cells.lock().remove(id);
    }

    /// Study closed: every cell and every decoded slice. Returns what was
    /// held (logged by the close bench, so a regression names its cache).
    pub fn close_all(&self) -> ClosedReport {
        let mut report = ClosedReport::default();
        {
            let mut cells = self.cells.lock();
            report.cells = cells.len();
            report.cell_textures_mb = cells
                .values()
                .filter_map(|c| c.gpu.as_ref()?.image.as_ref().map(|(_, im)| match im {
                    CellImage::Slice(b) => b.size() as f64 / 1_048_576.0,
                    CellImage::Rgba(t) => t.width() as f64 * t.height() as f64 * 4.0 / 1_048_576.0,
                }))
                .sum();
            cells.clear();
        }
        if let Some(store) = self.store.get() {
            let st = store.stats();
            report.store_mb = st.used_mb;
            report.store_slices = st.slices;
            store.clear();
        }
        report.volume_mb = crate::volume::held_bytes() as f64 / 1_048_576.0;
        // wgpu destroys dropped textures / buffers only once the GPU is done
        // with them, on a later poll: wait for that now rather than at the
        // next frame (none may come on the home screen).
        #[cfg(target_os = "macos")]
        let _surface = self.surface_lock.lock();
        if let Some(gpu) = self.gpu.lock().as_mut() {
            #[cfg(target_os = "macos")]
            {
                report.gpu_allocated_unflushed_mb = metal_allocated_mb(&gpu.device);
            }
            flush_and_wait(gpu);
            #[cfg(target_os = "macos")]
            park_surface(gpu);
            if let Some(r) = gpu.device.generate_allocator_report() {
                report.gpu_allocated_mb = Some(r.total_allocated_bytes as f64 / 1_048_576.0);
                report.gpu_reserved_mb = Some(r.total_reserved_bytes as f64 / 1_048_576.0);
            }
            // Metal has no allocator report: the device's own count of every
            // resource it holds (on Apple silicon this is in our footprint).
            #[cfg(target_os = "macos")]
            if report.gpu_allocated_mb.is_none() {
                report.gpu_allocated_mb = metal_allocated_mb(&gpu.device);
            }
        }
        report
    }

    /// A viewport shows a series or a volume plane (a study is open).
    pub fn has_viewports(&self) -> bool {
        self.cells.lock().values().any(|c| !c.series.is_empty() || c.plane.is_some())
    }

    /// No viewport left (study closed): drop whatever slices landed in the
    /// cache since, plus any cell an in-flight call re-created. Returns the
    /// slices dropped, or None when viewports exist (a study is open again).
    pub fn sweep_if_idle(&self) -> Option<usize> {
        if self.has_viewports() {
            return None;
        }
        self.cells.lock().clear();
        let store = self.store.get()?;
        let n = store.stats().slices;
        store.clear();
        #[cfg(target_os = "macos")]
        let _surface = self.surface_lock.lock();
        if let Some(gpu) = self.gpu.lock().as_mut() {
            flush_and_wait(gpu);
            // A frame drawn after the close (an in-flight call) unparked it.
            #[cfg(target_os = "macos")]
            if !gpu.parked {
                park_surface(gpu);
            }
        }
        Some(n)
    }

    /// Image pixel value under a cell point (CSS px), modality units.
    pub fn pick(&self, id: &str, x: f32, y: f32) -> Option<(f32, f32, i16)> {
        let (path, t) = {
            let cells = self.cells.lock();
            let c = cells.get(id)?;
            let path = c.series.get(c.view.index)?.clone();
            let (cols, rows) = c.gpu.as_ref().map(|g| g.dims)?;
            (path, Transform::new(&c.view, cols, rows, c.rect.w, c.rect.h))
        };
        let (col, row) = t.to_image(x, y);
        let slice = self.store().peek(&path)?;
        if col < 0.0 || row < 0.0 || col as usize >= slice.cols || row as usize >= slice.rows {
            return None;
        }
        Some((col, row, slice.data[row as usize * slice.cols + col as usize]))
    }

    /// P2.3: statistics of a region of the cell's current slice (image px
    /// coordinates), from the decoded modality values: mean, SD, min, max,
    /// pixel count and area (mm², from Pixel Spacing).
    pub fn roi_stats(&self, id: &str, shape: &RoiShape) -> Option<RoiStats> {
        let path = {
            let cells = self.cells.lock();
            let c = cells.get(id)?;
            c.series.get(c.view.index)?.clone()
        };
        let slice = self.store().peek(&path).or_else(|| self.store().get(&path).ok())?;
        Some(roi_stats(&slice, shape))
    }

    /// `wait`: return once the frame is presented (`draw`): a new series
    /// or plane; a scroll or view change returns once it is drawn.
    fn show(&self, id: &str, patch: Option<ViewPatch>, reset_wl: bool, scale: f64, wait: bool) -> Result<ShowResult, String> {
        let started = Instant::now();
        // 0. A volume plane: resample it (multi-core, from the shared volume).
        let plane_src = {
            let mut cells = self.cells.lock();
            let c = cells.get_mut(id).ok_or("no such viewport")?;
            match c.plane {
                Some(p) => {
                    if let Some(pt) = &patch {
                        c.view.apply(pt);
                    }
                    c.view.index = c.view.index.min(p.depth.saturating_sub(1));
                    Some((p, c.view.index))
                }
                None => None,
            }
        };
        if let Some((p, index)) = plane_src {
            let v = crate::volume::current(p.key).ok_or("the volume is not built")?;
            let (w, h, data, px) = crate::volume::render_values(&v, p.plane, index, p.max_dim, p.slab, p.mm);
            let slice = Slice { rows: h, cols: w, data, window: v.window, spacing: [px, px] };
            let decode_ms = started.elapsed().as_secs_f64() * 1000.0;
            let default_window = Some(slice.window.unwrap_or_else(|| data_window(&slice)));
            if reset_wl {
                if let (Some(dw), Some(c)) = (default_window, self.cells.lock().get_mut(id)) {
                    c.view.wl = (dw.0 as f32, dw.1 as f32);
                }
            }
            let key = PathBuf::from(format!("plane:{}:{:?}:{index}:{:?}:{}:{}", p.key, p.plane, p.slab, p.mm, p.max_dim));
            self.upload(id, &key, &slice)?;
            let frame_ms = self.draw(scale, wait)?;
            let data_max = slice.data.iter().copied().max().unwrap_or(0);
            let cells = self.cells.lock();
            let c = cells.get(id).ok_or("viewport closed")?;
            return Ok(ShowResult {
                index,
                count: p.depth,
                cached: false,
                decode_ms,
                frame_ms,
                acquire_ms: last_acquire_ms(),
                total_ms: started.elapsed().as_secs_f64() * 1000.0,
                rows: h,
                cols: w,
                window: c.view.wl,
                view: c.view,
                transform: Transform::new(&c.view, w, h, c.rect.w, c.rect.h),
                default_window,
                data_max,
            });
        }
        // 1. Apply the view and find the slice + what to prefetch (no GPU lock held).
        let (path, ahead, count) = {
            let mut cells = self.cells.lock();
            let c = cells.get_mut(id).ok_or("no such viewport")?;
            let prev = c.view.index;
            if let Some(p) = &patch {
                c.view.apply(p);
            }
            if c.series.is_empty() {
                (None, vec![], 0)
            } else {
                c.view.index = c.view.index.min(c.series.len() - 1);
                let index = c.view.index;
                let forward = index >= prev;
                let mut ahead = Vec::new();
                for k in 1..=24usize {
                    let i = if forward { index.checked_add(k) } else { index.checked_sub(k) };
                    if let Some(p) = i.and_then(|i| c.series.get(i)) {
                        ahead.push(p.clone());
                    }
                    if k <= 4 {
                        let j = if forward { index.checked_sub(k) } else { index.checked_add(k) };
                        if let Some(p) = j.and_then(|j| c.series.get(j)) {
                            ahead.push(p.clone());
                        }
                    }
                }
                (Some(c.series[index].clone()), ahead, c.series.len())
            }
        };
        // 2. Decode (or take from the cache) outside every lock.
        let store = self.store();
        let mut cached = true;
        let mut decode_ms = 0.0;
        let slice = match &path {
            Some(p) => Some(match store.peek(p) {
                Some(s) => s,
                None => {
                    cached = false;
                    let s = store.get(p)?;
                    decode_ms = started.elapsed().as_secs_f64() * 1000.0;
                    s
                }
            }),
            None => None,
        };
        // 3. Upload and draw.
        let default_window = slice.as_ref().map(|s| s.window.unwrap_or_else(|| data_window(s)));
        if reset_wl {
            if let (Some(w), Some(c)) = (default_window, self.cells.lock().get_mut(id)) {
                c.view.wl = (w.0 as f32, w.1 as f32);
            }
        }
        if let (Some(p), Some(s)) = (&path, &slice) {
            self.upload(id, p, s)?;
        }
        let frame_ms = self.draw(scale, wait)?;
        if !ahead.is_empty() {
            store.prefetch(ahead);
        }
        let cells = self.cells.lock();
        let c = cells.get(id).ok_or("viewport closed")?;
        let (cols, rows) = slice.as_ref().map(|s| (s.cols, s.rows)).unwrap_or((TEST_SIZE as usize, TEST_SIZE as usize));
        Ok(ShowResult {
            index: c.view.index,
            count,
            cached,
            decode_ms,
            frame_ms,
            acquire_ms: last_acquire_ms(),
            total_ms: started.elapsed().as_secs_f64() * 1000.0,
            rows,
            cols,
            window: c.view.wl,
            view: c.view,
            transform: Transform::new(&c.view, cols, rows, c.rect.w, c.rect.h),
            default_window,
            data_max: slice.as_ref().map(|s| s.data.iter().copied().max().unwrap_or(0)).unwrap_or(0),
        })
    }

    /// Make sure the cell's slice buffer holds `slice` (reused across a series).
    fn upload(&self, id: &str, path: &std::path::Path, slice: &Slice) -> Result<(), String> {
        let guard = self.gpu.lock();
        let gpu = guard.as_ref().ok_or("native renderer not initialised")?;
        let mut cells = self.cells.lock();
        let c = cells.get_mut(id).ok_or("no such viewport")?;
        let cg = c.gpu.get_or_insert_with(|| new_cell_gpu(gpu, &gpu.test_image));
        if matches!(&cg.image, Some((p, CellImage::Slice(_))) if p == path) {
            return Ok(());
        }
        let bytes = slice_bytes(&slice.data);
        // A new buffer per slice in write-back memory where the adapter
        // shares it (no GPU copy); the one it replaces is freed once the
        // frames that read it are done.
        #[cfg(windows)]
        if gpu.direct_slices {
            if let Some(buffer) = crate::native_uma::storage_buffer(&gpu.device, &bytes) {
                cg.bind_group = bind_group(gpu, &cg.uniforms, &buffer);
                cg.image = Some((path.to_path_buf(), CellImage::Slice(buffer)));
                cg.dims = (slice.cols, slice.rows);
                cg.generation = next_gen();
                return Ok(());
            }
        }
        let size = slice_buffer_size(slice.cols, slice.rows);
        let reuse = match cg.image.take() {
            Some((_, CellImage::Slice(b))) if b.size() == size => Some(b),
            _ => None,
        };
        let fresh = reuse.is_none();
        let buffer = reuse.unwrap_or_else(|| slice_buffer(&gpu.device, slice.cols, slice.rows));
        gpu.queue.write_buffer(&buffer, 0, &bytes);
        if fresh {
            cg.bind_group = bind_group(gpu, &cg.uniforms, &buffer);
        }
        cg.image = Some((path.to_path_buf(), CellImage::Slice(buffer)));
        cg.dims = (slice.cols, slice.rows);
        cg.generation = next_gen();
        Ok(())
    }

    /// Draw every cell. `scale`: physical px per CSS px. macOS: the frame
    /// is drawn now and presented by the presenter thread (`draw`).
    pub fn render(&self, scale: f64) -> Result<f64, String> {
        self.draw(scale, false)
    }

    /// Draw every cell and present the frame. Windows / Linux: both here, as
    /// always (Mailbox / flip model: a present never waits for the display).
    ///
    /// macOS: drawn here into an offscreen frame and presented by the
    /// presenter thread (`present_latest`), which waits for one of the
    /// layer's drawables in its place. Metal offers no Mailbox, and CAMetalLayer
    /// hands a drawable back only once the window server has composited a
    /// newer frame. Right after a study opened, while the study view's first
    /// paints were being composited, that took 40-190 ms on the CI runner,
    /// and the scroll, zoom or W/L step that came then waited for it (CI:
    /// "scroll step 2: Rust 136 ms, of which waiting for a drawable 134.3",
    /// with all three drawables already created, in 0.2-18 ms, and only the
    /// first image and two steps presented). Now no step waits for the
    /// compositor: the presenter puts the newest frame on screen as soon as a
    /// drawable is free, and frames drawn meanwhile are superseded, as with
    /// Mailbox. `wait`: present this frame on this thread and return once it
    /// is presented (a viewport's first image or new series, a volume plane,
    /// a 3D frame), as before.
    fn draw(&self, scale: f64, wait: bool) -> Result<f64, String> {
        #[cfg(target_os = "macos")]
        {
            self.draw_offscreen(scale, wait)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = wait;
            self.render_direct(scale)
        }
    }

    /// Windows / Linux: acquire the swap chain's next image, draw, present.
    #[cfg(not(target_os = "macos"))]
    fn render_direct(&self, scale: f64) -> Result<f64, String> {
        let started = Instant::now();
        let mut guard = self.gpu.lock();
        let gpu = guard.as_mut().ok_or("native renderer not initialised")?;
        *self.last_use.lock() = Some(Instant::now());
        if gpu.parked {
            gpu.surface.configure(&gpu.device, &gpu.config);
            gpu.parked = false;
        }
        let acquiring = Instant::now();
        let frame = match gpu.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            wgpu::CurrentSurfaceTexture::Occluded | wgpu::CurrentSurfaceTexture::Timeout => return Ok(0.0),
            _ => {
                // Outdated / lost (resize, display change): reconfigure once.
                gpu.surface.configure(&gpu.device, &gpu.config);
                match gpu.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
                    _ => return Err("surface unavailable".into()),
                }
            }
        };
        LAST_ACQUIRE_US.store(acquiring.elapsed().as_micros() as u64, std::sync::atomic::Ordering::Relaxed);
        let target = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let (sw, sh) = (gpu.config.width, gpu.config.height);
        let mut cells = self.cells.lock();
        let encoder = encode_cells(gpu, &mut cells, &target, sw, sh, scale as f32);
        drop(cells);
        gpu.queue.submit(Some(encoder.finish()));
        gpu.queue.present(frame);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut st = self.status.lock();
        st.last_frame_ms = Some(ms);
        st.frames += 1;
        Ok(ms)
    }

    /// macOS: draw the frame into the offscreen texture (no drawable needed)
    /// and hand it to the presenter. A frame identical to the one last drawn
    /// (the first image's layout pass and view refresh) is not drawn or
    /// presented again (`frame_signature`), nor is a frame without an image
    /// over a surface that shows none.
    #[cfg(target_os = "macos")]
    fn draw_offscreen(&self, scale: f64, wait: bool) -> Result<f64, String> {
        let started = Instant::now();
        let generation = {
            let mut guard = self.gpu.lock();
            let gpu = guard.as_mut().ok_or("native renderer not initialised")?;
            *self.last_use.lock() = Some(Instant::now());
            if gpu.parked {
                // Configured by the presenter, before its next drawable.
                gpu.parked = false;
                gpu.needs_configure = true;
                // The layer still shows the parked 1×1 canvas-colour frame.
                gpu.drawn = initially_shown();
            }
            let (sw, sh) = (gpu.config.width, gpu.config.height);
            let s = scale as f32;
            let mut cells = self.cells.lock();
            let signature = frame_signature(&cells, sw, sh, s);
            if gpu.drawn != Some(signature) {
                if gpu.offscreen.as_ref().map_or(true, |t| t.width() != sw || t.height() != sh) {
                    gpu.offscreen = Some(gpu.device.create_texture(&wgpu::TextureDescriptor {
                        label: Some("frame"),
                        size: wgpu::Extent3d { width: sw, height: sh, depth_or_array_layers: 1 },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: gpu.config.format,
                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
                        view_formats: &[],
                    }));
                }
                let target = gpu.offscreen.as_ref().map(|t| t.create_view(&wgpu::TextureViewDescriptor::default())).ok_or("no frame texture")?;
                let encoder = encode_cells(gpu, &mut cells, &target, sw, sh, s);
                drop(cells);
                gpu.queue.submit(Some(encoder.finish()));
                gpu.drawn = Some(signature);
                self.present.lock().drawn += 1;
                self.status.lock().frames += 1;
            }
            self.present.lock().drawn
        };
        LAST_ACQUIRE_US.store(0, std::sync::atomic::Ordering::Relaxed);
        if wait {
            // Presented here, not by waking the presenter: no thread hop on
            // a first image's path (the presenter may be presenting an
            // earlier frame; the surface lock orders the two).
            let shown = self.present_latest();
            let mut p = self.present.lock();
            p.shown = p.shown.max(shown.unwrap_or(generation));
            LAST_ACQUIRE_US.store((p.acquire_ms * 1000.0) as u64, std::sync::atomic::Ordering::Relaxed);
        }
        self.present_cv.notify_all();
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        self.status.lock().last_frame_ms = Some(ms);
        Ok(ms)
    }

    /// macOS: start the presenter thread (once; the GPU exists).
    #[cfg(target_os = "macos")]
    pub fn start_presenter(self: &Arc<Self>) {
        if self.presenter.set(()).is_err() {
            return;
        }
        let native = self.clone();
        if std::thread::Builder::new().name("flowrad-present".into()).spawn(move || native.present_loop()).is_err() {
            eprintln!("flowrad: the presenter thread did not start");
        }
    }

    /// macOS: present the newest drawn frame whenever one is waiting.
    #[cfg(target_os = "macos")]
    fn present_loop(&self) {
        loop {
            let wanted = {
                let mut p = self.present.lock();
                while p.drawn <= p.shown {
                    self.present_cv.wait(&mut p);
                }
                p.drawn
            };
            let shown = self.present_latest();
            let mut p = self.present.lock();
            // Not presented (occluded, parked, no GPU): done all the same; the
            // next frame drawn asks again.
            p.shown = p.shown.max(shown.unwrap_or(wanted));
            drop(p);
            self.present_cv.notify_all();
        }
    }

    /// macOS: wait for a drawable (without the GPU lock, so frames go on
    /// being drawn meanwhile), then copy the newest frame onto it and present
    /// it. Returns the frame's generation, or None when nothing was presented.
    #[cfg(target_os = "macos")]
    fn present_latest(&self) -> Option<u64> {
        let _surface = self.surface_lock.lock();
        // Presented meanwhile (by the presenter, or by a frame that waited).
        {
            let p = self.present.lock();
            if p.shown >= p.drawn {
                return None;
            }
        }
        let surface = {
            let mut guard = self.gpu.lock();
            let gpu = guard.as_mut()?;
            if gpu.parked || gpu.offscreen.is_none() {
                return None;
            }
            if gpu.needs_configure {
                gpu.surface.configure(&gpu.device, &gpu.config);
                gpu.needs_configure = false;
            }
            gpu.surface.clone()
        };
        let acquiring = Instant::now();
        let frame = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            wgpu::CurrentSurfaceTexture::Occluded | wgpu::CurrentSurfaceTexture::Timeout => return None,
            _ => {
                // Outdated / lost (display change): reconfigure for the next one.
                if let Some(gpu) = self.gpu.lock().as_mut() {
                    gpu.needs_configure = true;
                }
                return None;
            }
        };
        let acquire_ms = acquiring.elapsed().as_secs_f64() * 1000.0;
        let guard = self.gpu.lock();
        let gpu = guard.as_ref()?;
        let src = gpu.offscreen.as_ref()?;
        let size = frame.texture.size();
        // Resized or parked while this thread waited: dropped unpresented;
        // the frame drawn after the change presents at the new size.
        if gpu.parked || gpu.needs_configure || src.size() != size {
            return None;
        }
        // Frames are drawn only under the GPU lock: this is the newest.
        let generation = self.present.lock().drawn;
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("present") });
        encoder.copy_texture_to_texture(src.as_image_copy(), frame.texture.as_image_copy(), size);
        gpu.queue.submit(Some(encoder.finish()));
        gpu.queue.present(frame);
        self.present.lock().acquire_ms = acquire_ms;
        Some(generation)
    }

    // ───────────── P2.1 spike API (the spike cell) ─────────────

    pub fn open_series(&self, paths: Vec<PathBuf>, scale: f64) -> Result<ShowResult, String> {
        self.store().clear();
        self.set_series(SPIKE, paths, 0, None, scale)
    }

    pub fn scroll_spike(&self, delta: i64, scale: f64) -> Result<ShowResult, String> {
        self.scroll(SPIKE, delta, scale)
    }
}

/// The signature of a frame that draws no image: the canvas colour only,
/// whatever the surface size. A surface that has presented nothing looks the
/// same (the window's canvas colour shows through the empty layer).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const EMPTY_FRAME: u64 = 0;

/// What a frame of `cells` on a `sw` × `sh` surface draws: every drawn
/// cell's rectangle, window / level and transform, and which image (and
/// which upload of it) it samples. Equal signatures draw equal pixels. A cell
/// without an image is not drawn (`encode_cells`), so it does not count: the
/// layout frame before a study's first image draws the canvas colour only.
///
/// macOS draws (and presents) a frame only when its signature differs from
/// the last one drawn: a study's first image is followed by its layout pass
/// and the view refresh that pass triggers, the same pixels each time, and
/// each present holds one of CAMetalLayer's three drawables until the window
/// server has composited a newer frame.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn frame_signature(cells: &HashMap<String, CellState>, sw: u32, sh: u32, s: f32) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let mut drawn = false;
    let mut order: Vec<(&String, &CellState)> = cells.iter().collect();
    order.sort_by(|a, b| a.0.cmp(b.0));
    for (id, c) in order {
        let Some(cg) = &c.gpu else { continue };
        // As `render`: an app cell without a slice is not drawn (the spike
        // cell draws its test image).
        if cg.image.is_none() && id != SPIKE {
            continue;
        }
        if !drawn {
            (sw, sh, s.to_bits()).hash(&mut h);
            drawn = true;
        }
        id.hash(&mut h);
        for x in [c.rect.x, c.rect.y, c.rect.w, c.rect.h, c.view.wl.0, c.view.wl.1] {
            x.to_bits().hash(&mut h);
        }
        (cg.generation, cg.dims, cg.image.is_some(), cg.rgba(), c.view.invert).hash(&mut h);
        let (cols, rows) = if cg.image.is_some() { cg.dims } else { (TEST_SIZE as usize, TEST_SIZE as usize) };
        let t = Transform::new(&c.view, cols, rows, c.rect.w, c.rect.h);
        for x in [t.scale, t.center.0, t.center.1, t.cos, t.sin, t.flip_x, t.flip_y] {
            x.to_bits().hash(&mut h);
        }
    }
    // Never EMPTY_FRAME for a frame that draws something.
    if drawn {
        h.finish() | 1
    } else {
        EMPTY_FRAME
    }
}

/// What a new surface shows, as a frame signature. macOS: nothing (an empty
/// layer over the window's canvas colour), the same as a frame without an
/// image, so that frame is not presented and a study's first image finds
/// every drawable free. Elsewhere unused.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn initially_shown() -> Option<u64> {
    cfg!(target_os = "macos").then_some(EMPTY_FRAME)
}

/// Record one frame of `cells` into `target` (`sw` × `sh` device px; `s`:
/// device px per CSS px): each cell's uniforms, then one pass that clears to
/// the canvas colour and draws every cell with an image, scissored to it.
fn encode_cells(gpu: &Gpu, cells: &mut HashMap<String, CellState>, target: &wgpu::TextureView, sw: u32, sh: u32, s: f32) -> wgpu::CommandEncoder {
    // Uniforms first (each cell has its own buffer), then one pass.
    for c in cells.values_mut() {
        let cg = c.gpu.get_or_insert_with(|| new_cell_gpu(gpu, &gpu.test_image));
        let (cols, rows) = if cg.image.is_some() { cg.dims } else { (TEST_SIZE as usize, TEST_SIZE as usize) };
        let t = Transform::new(&c.view, cols, rows, c.rect.w, c.rect.h);
        let data: [f32; 20] = [
            c.rect.x * s, c.rect.y * s, c.rect.w * s, c.rect.h * s,
            c.view.wl.0, c.view.wl.1, sw as f32, sh as f32,
            t.scale * s, t.center.0 * s, t.center.1 * s, if c.view.invert { 1.0 } else { 0.0 },
            t.cos, t.sin, t.flip_x, t.flip_y,
            cols as f32, rows as f32, 0.0, 0.0,
        ];
        // SAFETY: [f32; 20] is 80 plain bytes.
        let bytes = unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, std::mem::size_of_val(&data)) };
        gpu.queue.write_buffer(&cg.uniforms, 0, bytes);
    }
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("cells"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    // The app canvas colour behind everything the page does not cover.
                    load: wgpu::LoadOp::Clear(wgpu::Color { r: 11.0 / 255.0, g: 13.0 / 255.0, b: 16.0 / 255.0, a: 1.0 }), // --canvas #0B0D10
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&gpu.pipeline);
        // Stable order: a cell's lens ("<id>:lens") draws after (over) the cell.
        let mut order: Vec<(&String, &CellState)> = cells.iter().collect();
        order.sort_by(|a, b| a.0.cmp(b.0));
        for (id, c) in order {
            let Some(cg) = &c.gpu else { continue };
            // An app cell without a slice stays the page's (no test image there).
            if cg.image.is_none() && id != SPIKE {
                continue;
            }
            // Clip to the cell and to the surface.
            let Some((x0, y0, cw, ch)) = device_clip(c.rect.x, c.rect.y, c.rect.w, c.rect.h, s, sw, sh) else { continue };
            pass.set_scissor_rect(x0, y0, cw, ch);
            pass.set_pipeline(if cg.rgba() { &gpu.pipeline_rgba } else { &gpu.pipeline });
            pass.set_bind_group(0, &cg.bind_group, &[]);
            pass.draw(0..6, 0..1);
        }
    }
    encoder
}

/// Give back what dropped GPU resources still hold. wgpu frees a dropped
/// texture or buffer only once no submission uses it, and an upload not yet
/// submitted (write_texture / write_buffer: its staging buffer and target)
/// counts as one until the next submit, which on the home screen may never
/// come (CI, macOS: Metal held 7.3 MB after close, 6.2 MB with the study
/// open). An empty submit flushes those writes; the wait then lets wgpu
/// destroy everything that was only waiting on the GPU. Windows / Linux:
/// just the wait, as before (the empty submit is the macOS fix; keeping
/// D3D12 unchanged keeps the Windows close gate comparable).
fn flush_and_wait(gpu: &Gpu) {
    #[cfg(target_os = "macos")]
    gpu.queue.submit(std::iter::empty());
    let _ = gpu.device.poll(wgpu::PollType::Wait { submission_index: None, timeout: Some(std::time::Duration::from_millis(500)) });
}

/// macOS, study closed: hand back the window-sized drawables. The
/// CAMetalLayer keeps a pool of them (up to frame latency + 1, each a
/// window-sized IOSurface in our footprint) for as long as its drawableSize
/// holds, and it keeps the last one presented as its contents for as long as
/// nothing replaces it. The home screen draws nothing natively, so both
/// stayed: changing the size dropped the pool, but the frame on screen stayed
/// (CI: IOSurface +5.3 MB after close against the empty app, every run, with
/// the size restored at once). Parked, the layer is 1×1 and shows one 1×1
/// frame of the canvas colour (what a frame without cells draws); the next
/// frame restores the window size (`render`), as at start.
/// The offscreen frame goes too. Called with the surface lock held (the
/// presenter is not waiting for a drawable).
#[cfg(target_os = "macos")]
fn park_surface(gpu: &mut Gpu) {
    let mut tiny = gpu.config.clone();
    tiny.width = 1;
    tiny.height = 1;
    gpu.surface.configure(&gpu.device, &tiny);
    gpu.parked = true;
    gpu.needs_configure = false;
    gpu.drawn = None;
    gpu.offscreen = None;
    let frame = match gpu.surface.get_current_texture() {
        wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
        // Occluded / no drawable: the pool is gone already; the frame on
        // screen goes with the next one presented.
        _ => return,
    };
    let target = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("park") });
    drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("park"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: &target,
            resolve_target: None,
            depth_slice: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color { r: 11.0 / 255.0, g: 13.0 / 255.0, b: 16.0 / 255.0, a: 1.0 }), // --canvas #0B0D10
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    }));
    drop(target);
    gpu.queue.submit(Some(encoder.finish()));
    gpu.queue.present(frame);
    flush_and_wait(gpu);
}

/// Whether slices go straight into shared write-back memory (native_uma.rs).
fn direct_slices(device: &wgpu::Device) -> bool {
    #[cfg(windows)]
    {
        crate::native_uma::coherent_uma(device)
    }
    #[cfg(not(windows))]
    {
        let _ = device;
        false
    }
}

fn bind_group(gpu: &Gpu, uniforms: &wgpu::Buffer, slice: &wgpu::Buffer) -> wgpu::BindGroup {
    gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("cell"),
        layout: &gpu.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: slice.as_entire_binding() },
        ],
    })
}

fn new_cell_gpu(gpu: &Gpu, initial: &wgpu::Buffer) -> CellGpu {
    let uniforms = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("cell uniforms"),
        size: 80,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let bind_group = bind_group(gpu, &uniforms, initial);
    CellGpu { uniforms, bind_group, image: None, dims: (TEST_SIZE as usize, TEST_SIZE as usize), generation: next_gen() }
}

/// P2.1 bench / spike: the DICOM files under `roots`, grouped by series, the
/// largest series in display order (Image Position along the normal, else
/// Instance Number, else file name). Headers are read in parallel.
pub fn largest_series(roots: &[PathBuf]) -> Vec<PathBuf> {
    use dicom_dictionary_std::tags;
    use rayon::prelude::*;
    let files: Vec<PathBuf> = roots
        .iter()
        .flat_map(|r| walkdir::WalkDir::new(r).into_iter().filter_map(Result::ok))
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .collect();
    let mut rows: Vec<(String, f64, i64, PathBuf)> = files
        .par_iter()
        .filter_map(|p| {
            let h = dicom_object::OpenFileOptions::new().read_until(tags::PIXEL_DATA).open_file(p).ok()?;
            let series = h.element(tags::SERIES_INSTANCE_UID).ok()?.to_str().ok()?.trim_end_matches('\0').to_string();
            let z = crate::volume::num(&h, tags::IMAGE_POSITION_PATIENT, 2).unwrap_or(f64::NAN);
            let inst = crate::volume::int(&h, tags::INSTANCE_NUMBER).unwrap_or(0);
            Some((series, z, inst, p.clone()))
        })
        .collect();
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for r in &rows {
        *counts.entry(r.0.as_str()).or_default() += 1;
    }
    let Some(best) = counts.iter().max_by_key(|(_, n)| **n).map(|(s, _)| s.to_string()) else {
        return vec![];
    };
    rows.retain(|r| r.0 == best);
    rows.sort_by(|a, b| {
        if a.1.is_finite() && b.1.is_finite() {
            b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
        } else {
            a.2.cmp(&b.2).then_with(|| a.3.cmp(&b.3))
        }
    });
    rows.into_iter().map(|r| r.3).collect()
}

/// The device half of the engine, built before the window exists.
///
/// Cold, most of native start-up is the D3D12 runtime and driver loading and
/// the shaders compiling (the HP: ~2 s after a cache clear). None of that
/// needs a surface, so `prewarm` does it on its own thread from the first line
/// of `run()`, in parallel with WebView2 starting; `init` then only creates
/// the surface and configures it.
struct Warm {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipes: Pipes,
}

/// Pipelines and the bind-group layouts they use, for one surface format.
struct Pipes {
    format: wgpu::TextureFormat,
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    pipeline_rgba: wgpu::RenderPipeline,
    layout_rgba: wgpu::BindGroupLayout,
    /// The test image (spike / a cell before its first slice), as a slice buffer.
    test_image: wgpu::Buffer,
}

/// What DX12 / Vulkan swap chains offer first (non-sRGB); a surface that
/// wants another format just rebuilds the pipelines.
const LIKELY_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;

type WarmJob = std::thread::JoinHandle<Result<Warm, String>>;
static WARM: std::sync::Mutex<Option<WarmJob>> = std::sync::Mutex::new(None);

/// How long the background device build took (ms), for the startup report.
pub static WARM_MS: std::sync::OnceLock<f64> = std::sync::OnceLock::new();

/// Start building the device and pipelines now, off the main thread. No-op
/// while a build is in flight or untaken. Called
/// only while no device exists (at launch, and by `create_gpu` under the init
/// lock, which takes the job at once), so a build never outlives the GPU it
/// was for: one lock (`WARM`), one device. No-op when native mode is off.
pub fn prewarm() {
    if !enabled() {
        return;
    }
    let mut slot = WARM.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() {
        return; // already building (or built and not yet taken)
    }
    let job = std::thread::Builder::new().name("flowrad-gpu-warm".into()).spawn(|| {
        crate::trace("gpu warm: thread running");
        let started = Instant::now();
        let instance = shared_instance();
        let warm = futures_util::FutureExt::now_or_never(Box::pin(async {
            let (adapter, device, queue) = request_device(&instance, None).await?;
            let pipes = build_pipes(&device, &queue, LIKELY_FORMAT);
            Ok::<_, String>((adapter, device, queue, pipes))
        }));
        let r = match warm {
            Some(Ok((adapter, device, queue, pipes))) => Ok(Warm { instance, adapter, device, queue, pipes }),
            Some(Err(e)) => Err(e),
            // Native wgpu resolves these futures synchronously; if a backend
            // ever does not, `init` builds everything itself.
            None => Err("adapter request did not complete synchronously".into()),
        };
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        crate::trace("gpu warm: done");
        // The first build is the startup report's; the latest is the status's.
        let _ = WARM_MS.set(ms);
        *LAST_WARM_MS.lock() = Some(ms);
        r
    });
    if let Ok(job) = job {
        *slot = Some(job);
    }
}

/// How long the latest device build took (ms).
static LAST_WARM_MS: parking_lot::Mutex<Option<f64>> = parking_lot::Mutex::new(None);

/// The default-backend instance, kept across GPU releases: it holds the DXGI
/// factory and the loaded runtime libraries, not a device or driver heaps, so
/// a rebuild after a release does not load them again. (Dropping it with the
/// device was measured, CI 0.8.3: the closed app's private bytes were the
/// same within noise, 33 MB either way.)
fn shared_instance() -> wgpu::Instance {
    static INSTANCE: std::sync::Mutex<Option<wgpu::Instance>> = std::sync::Mutex::new(None);
    INSTANCE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(|| new_instance(None)).clone()
}

fn take_warm() -> Option<WarmJob> {
    WARM.lock().unwrap_or_else(|e| e.into_inner()).take()
}

fn backends_for(force: Option<wgpu::Backends>) -> wgpu::Backends {
    // Windows: Direct3D 12 only. With PRIMARY the Vulkan loader and the
    // vendor's Vulkan driver (the HP's Intel Arc picked Vulkan) load too: tens
    // to hundreds of ms on the startup path, competing with WebView2 for the
    // loader lock, plus the driver's own resident memory. FLOWRAD_WGPU_BACKENDS
    // (e.g. "vulkan", "dx12,vulkan") overrides for diagnosis.
    force
        .or_else(|| {
            std::env::var("FLOWRAD_WGPU_BACKENDS")
                .ok()
                .map(|s| wgpu::Backends::from_comma_list(&s))
                .filter(|b| !b.is_empty())
        })
        .unwrap_or(if cfg!(target_os = "windows") { wgpu::Backends::DX12 } else { wgpu::Backends::PRIMARY })
}

fn new_instance(force: Option<wgpu::Backends>) -> wgpu::Instance {
    wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: backends_for(force),
        flags: instance_flags(),
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    })
}

/// wgpu's build-config flags without indirect-call validation: the renderer
/// never draws or dispatches indirectly, and with it every device compiles
/// two validation compute pipelines and keeps their buffers.
fn instance_flags() -> wgpu::InstanceFlags {
    wgpu::InstanceFlags::from_build_config().difference(wgpu::InstanceFlags::VALIDATION_INDIRECT_CALL)
}

/// D3D12 shader-visible CBV/SRV/UAV descriptors the device reserves up front.
/// wgpu's default (`max_non_sampler_bindings`, 1,000,000) is one descriptor
/// heap of 32-64 MB (32 B a descriptor on WARP / NVIDIA, 64 B on some Intel
/// parts), allocated when the device is created and resident for as long as
/// it lives: on WARP and on integrated GPUs that is system memory, in the
/// app's private bytes with a study open. The renderer binds two descriptors
/// a viewport (uniforms + its slice, one bind group, rebuilt only when the
/// slice size changes), so 8,192 is hundreds of times what it can use, in a
/// 256-512 KB heap. Only D3D12 reads this limit; other backends ignore it.
pub(crate) const VIEW_DESCRIPTORS: u32 = 8192;

/// GPU allocator blocks (wgpu's gpu-allocator, D3D12 / Vulkan): 4 MB device
/// and upload blocks to start with, growing to 64 / 32 MB for big uploads
/// (MPR volumes). "MemoryUsage" starts at 8 + 4 MB; a CT viewport's texture is
/// 0.5 MB and its staging copy the same, so the first device block sat mostly
/// empty (CI: 12 MB reserved, 1.1 MB allocated). On an integrated GPU or WARP
/// the blocks are system memory in our working set.
fn memory_hints() -> wgpu::MemoryHints {
    wgpu::MemoryHints::Manual { suballocated_device_memory_block_size: (4 << 20)..(64 << 20) }
}

/// The limits the device is created with: downlevel defaults at the adapter's
/// texture sizes, and a small D3D12 descriptor heap (`VIEW_DESCRIPTORS`).
fn device_limits(adapter: wgpu::Limits) -> wgpu::Limits {
    wgpu::Limits {
        max_non_sampler_bindings: VIEW_DESCRIPTORS.min(adapter.max_non_sampler_bindings),
        ..wgpu::Limits::downlevel_defaults().using_resolution(adapter)
    }
}

async fn request_device(
    instance: &wgpu::Instance,
    surface: Option<&wgpu::Surface<'static>>,
) -> Result<(wgpu::Adapter, wgpu::Device, wgpu::Queue), String> {
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: surface,
            ..Default::default()
        })
        .await
        .map_err(|e| format!("adapter: {e}"))?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("flowrad-native"),
            required_features: wgpu::Features::empty(),
            required_limits: device_limits(adapter.limits()),
            // Small allocator blocks: on an integrated GPU (shared memory) the
            // default "performance" blocks are resident in our working set.
            memory_hints: memory_hints(),
            ..Default::default()
        })
        .await
        .map_err(|e| format!("device: {e}"))?;
    Ok((adapter, device, queue))
}

async fn create_gpu(window: &tauri::WebviewWindow) -> Result<(Gpu, String, String), String> {
    // The device built in the background (at launch, or since the page said a
    // study is about to open), when it suits this window. None in flight
    // (lazy GPU, or released since): build it on that thread now, not on an
    // async worker.
    prewarm();
    if let Some(job) = take_warm() {
        let joined = tauri::async_runtime::spawn_blocking(move || job.join()).await;
        if let Ok(Ok(Ok(warm))) = joined {
            match finish_warm(window, warm) {
                Ok(gpu) => return Ok(gpu),
                Err(e) => eprintln!("flowrad: warm device unusable ({e}); creating a new one"),
            }
        }
    }
    match create_gpu_on(window, None).await {
        Ok(gpu) => Ok(gpu),
        // No usable D3D12 adapter: every primary backend before giving up.
        Err(e) if cfg!(target_os = "windows") => create_gpu_on(window, Some(wgpu::Backends::PRIMARY)).await.map_err(|e2| format!("{e}; {e2}")),
        Err(e) => Err(e),
    }
}

/// Last frame: µs spent waiting for the next drawable (render → ShowResult).
static LAST_ACQUIRE_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn last_acquire_ms() -> f64 {
    LAST_ACQUIRE_US.load(std::sync::atomic::Ordering::Relaxed) as f64 / 1000.0
}

/// A frame never waits for the display's vblank: Mailbox (D3D12 / Vulkan:
/// the newest frame wins, no tearing). Metal offers only Fifo and Immediate,
/// and with Fifo and two drawables a step waited for a free drawable over
/// several display refreshes (CI macOS: scroll step 1, 60 ms of a 62 ms
/// step was the frame): Immediate presents at once (CAMetalLayer
/// displaySyncEnabled = false; the window server composites it, so no
/// tearing in a window). Fifo where neither is offered.
pub(crate) fn present_mode_for(modes: &[wgpu::PresentMode]) -> wgpu::PresentMode {
    if modes.contains(&wgpu::PresentMode::Mailbox) {
        wgpu::PresentMode::Mailbox
    } else if cfg!(target_os = "macos") && modes.contains(&wgpu::PresentMode::Immediate) {
        wgpu::PresentMode::Immediate
    } else {
        wgpu::PresentMode::Fifo
    }
}

/// Frames the swapchain may queue (wgpu: drawables = this + 1). macOS: 2,
/// so CAMetalLayer keeps three drawables. With two, one is on screen and the
/// other still queued at the window server right after the first image and
/// the layout frame, so the next frame (CI: scroll step 0) waited 63.5 ms
/// for one to come back, Immediate or not. Elsewhere 1 (Mailbox / flip
/// model never waits on the display).
pub(crate) fn frame_latency() -> u32 {
    if cfg!(target_os = "macos") {
        2
    } else {
        1
    }
}

/// macOS: MB of GPU resources the Metal device holds (MTLDevice
/// currentAllocatedSize), for the close report.
#[cfg(target_os = "macos")]
fn metal_allocated_mb(device: &wgpu::Device) -> Option<f64> {
    use objc2_metal::MTLDevice;
    // SAFETY: only reads a counter; the device outlives the guard.
    let hal = unsafe { device.as_hal::<wgpu::hal::api::Metal>() }?;
    Some((hal.raw_device().currentAllocatedSize() as f64 / 1_048_576.0 * 10.0).round() / 10.0)
}

/// macOS: the last surface creation's wait for the main thread, ms (reported
/// in the status; the bench prints it with the first image).
static SURFACE_WAIT_MS: parking_lot::Mutex<Option<f64>> = parking_lot::Mutex::new(None);

/// The window's surface. macOS: creating it attaches a CAMetalLayer to the
/// window's NSView, and AppKit views are main-thread only (raw-window-metal
/// panics elsewhere: "can only access NSView on the main thread"), so it is
/// created on the main thread and handed back. Configuring, acquiring and
/// presenting touch only the layer, which wgpu-hal does off the main thread.
/// Windows / Linux: created here, as before.
fn create_surface(instance: &wgpu::Instance, window: &tauri::WebviewWindow) -> Result<wgpu::Surface<'static>, String> {
    #[cfg(target_os = "macos")]
    {
        // Already on the main thread: create it directly (waiting would deadlock).
        if objc2::MainThreadMarker::new().is_some() {
            return instance.create_surface(window.as_ref().window()).map_err(|e| format!("surface: {e}"));
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let (instance, target) = (instance.clone(), window.as_ref().window());
        let asked = Instant::now();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(instance.create_surface(target).map_err(|e| format!("surface: {e}")));
            })
            .map_err(|e| format!("surface: main thread unavailable: {e}"))?;
        let surface = rx.recv().map_err(|e| format!("surface: main thread dropped the request: {e}"))?;
        *SURFACE_WAIT_MS.lock() = Some(asked.elapsed().as_secs_f64() * 1000.0);
        surface
    }
    #[cfg(not(target_os = "macos"))]
    instance.create_surface(window.as_ref().window()).map_err(|e| format!("surface: {e}"))
}

fn finish_warm(window: &tauri::WebviewWindow, warm: Warm) -> Result<(Gpu, String, String), String> {
    let Warm { instance, adapter, device, queue, pipes } = warm;
    let surface = create_surface(&instance, window)?;
    if !adapter.is_surface_supported(&surface) {
        return Err("adapter cannot present to this window".into());
    }
    finish(window, &adapter, surface, device, queue, Some(pipes))
}

async fn create_gpu_on(window: &tauri::WebviewWindow, force: Option<wgpu::Backends>) -> Result<(Gpu, String, String), String> {
    let instance = new_instance(force);
    let surface = create_surface(&instance, window)?;
    let (adapter, device, queue) = request_device(&instance, Some(&surface)).await?;
    finish(window, &adapter, surface, device, queue, None)
}

/// Configure the surface; reuse pipelines already built for its format.
fn finish(
    window: &tauri::WebviewWindow,
    adapter: &wgpu::Adapter,
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipes: Option<Pipes>,
) -> Result<(Gpu, String, String), String> {
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let info = adapter.get_info();
    let caps = surface.get_capabilities(adapter);
    let format = *caps.formats.iter().find(|f| !f.is_srgb()).or(caps.formats.first()).ok_or("surface offers no formats")?;
    let config = wgpu::SurfaceConfiguration {
        // macOS: frames are copied onto the drawables (`draw`).
        usage: if cfg!(target_os = "macos") { wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_DST } else { wgpu::TextureUsages::RENDER_ATTACHMENT },
        format,
        width: size.width.max(1),
        height: size.height.max(1),
        // Never wait for the display's vblank (Fifo made every scroll call
        // wait ~16 ms+): see present_mode_for.
        present_mode: present_mode_for(&caps.present_modes),
        desired_maximum_frame_latency: frame_latency(),
        alpha_mode: caps.alpha_modes[0],
        color_space: wgpu::SurfaceColorSpace::Auto,
        view_formats: vec![],
    };
    surface.configure(&device, &config);
    let pipes = match pipes {
        Some(p) if p.format == format => p,
        _ => build_pipes(&device, &queue, format),
    };
    let Pipes { pipeline, layout, pipeline_rgba, layout_rgba, test_image, .. } = pipes;
    Ok((
        Gpu {
            direct_slices: direct_slices(&device),
            surface: Arc::new(surface),
            device,
            queue,
            config,
            pipeline,
            layout,
            pipeline_rgba,
            layout_rgba,
            test_image,
            parked: false,
            #[cfg(target_os = "macos")]
            drawn: initially_shown(),
            #[cfg(target_os = "macos")]
            offscreen: None,
            #[cfg(target_os = "macos")]
            needs_configure: false,
        },
        info.name,
        format!("{:?}", info.backend),
    ))
}

fn build_pipes(device: &wgpu::Device, queue: &wgpu::Queue, format: wgpu::TextureFormat) -> Pipes {
    let test_buffer = slice_buffer(device, TEST_SIZE as usize, TEST_SIZE as usize);
    queue.write_buffer(&test_buffer, 0, &slice_bytes(&test_image(TEST_SIZE)));
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("cell"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None },
                count: None,
            },
        ],
    });
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("cell"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("cell"),
        bind_group_layouts: &[Some(&layout)],
        ..Default::default()
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("cell"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs"),
            targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    });
    let layout_rgba = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("cell rgba"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
        ],
    });
    let shader_rgba = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("cell rgba"), source: wgpu::ShaderSource::Wgsl(SHADER_RGBA.into()) });
    let pipeline_layout_rgba = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("cell rgba"),
        bind_group_layouts: &[Some(&layout_rgba)],
        ..Default::default()
    });
    let pipeline_rgba = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("cell rgba"),
        layout: Some(&pipeline_layout_rgba),
        vertex: wgpu::VertexState { module: &shader_rgba, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState {
            module: &shader_rgba,
            entry_point: Some("fs"),
            targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    });
    Pipes { format, pipeline, layout, pipeline_rgba, layout_rgba, test_image: test_buffer }
}

/// A cell's CSS-px rect → the device-px scissor (x, y, w, h), clipped to the
/// surface. Both edges are ROUNDED: floor / ceil (0.8.1) grew every cell by
/// up to a pixel on each side at fractional DPI (125 %, 150 %), so a coronal or
/// sagittal plane spilled over its pane edge onto the axial pane's border.
/// Rounding the same edge the same way lets neighbours tile exactly.
pub fn device_clip(x: f32, y: f32, w: f32, h: f32, scale: f32, sw: u32, sh: u32) -> Option<(u32, u32, u32, u32)> {
    let edge = |v: f32, max: u32| ((v * scale).round().max(0.0) as u32).min(max);
    let (x0, y0) = (edge(x, sw), edge(y, sh));
    let (x1, y1) = (edge(x + w, sw), edge(y + h, sh));
    (x1 > x0 && y1 > y0).then(|| (x0, y0, x1 - x0, y1 - y0))
}

#[cfg(test)]
mod tests {
    /// The device asks for a small D3D12 descriptor heap (not wgpu's
    /// 1,000,000-descriptor, 32-64 MB default), small allocator blocks, and no
    /// indirect-call validation; everything else stays downlevel defaults.
    #[test]
    fn device_is_built_lean() {
        // What wgpu's D3D12 adapter reports, and what Vulkan / Metal / GL do.
        let d3d12 = wgpu::Limits { max_non_sampler_bindings: 1_000_000, ..wgpu::Limits::default() };
        let l = super::device_limits(d3d12.clone());
        assert_eq!(l.max_non_sampler_bindings, super::VIEW_DESCRIPTORS);
        assert_eq!(l.max_texture_dimension_2d, d3d12.max_texture_dimension_2d);
        assert_eq!(l.max_bind_groups, wgpu::Limits::downlevel_defaults().max_bind_groups);
        let unbounded = wgpu::Limits { max_non_sampler_bindings: u32::MAX, ..wgpu::Limits::default() };
        assert_eq!(super::device_limits(unbounded).max_non_sampler_bindings, super::VIEW_DESCRIPTORS);
        // Never more than the adapter has (request_device would refuse it).
        let tiny = wgpu::Limits { max_non_sampler_bindings: 100, ..wgpu::Limits::default() };
        assert_eq!(super::device_limits(tiny).max_non_sampler_bindings, 100);
        // Two descriptors a viewport: room for thousands of live bind groups.
        assert!(super::VIEW_DESCRIPTORS >= 4096);
        assert!(!super::instance_flags().contains(wgpu::InstanceFlags::VALIDATION_INDIRECT_CALL));
        match super::memory_hints() {
            wgpu::MemoryHints::Manual { suballocated_device_memory_block_size: r } => assert_eq!(r, (4 << 20)..(64 << 20)),
            other => panic!("{other:?}"),
        }
    }

    /// The slice buffer as the cell shader reads it: value i is the low
    /// (even i) or high (odd i) half of word i / 2, sign-extended; an odd
    /// count is zero-padded to whole words.
    #[test]
    fn slice_buffer_packs_two_signed_values_per_word() {
        let data: Vec<i16> = vec![-1, 2, i16::MIN, i16::MAX, -1024, 5, 0];
        let bytes = super::slice_bytes(&data);
        assert_eq!(bytes.len() as u64, super::slice_buffer_size(data.len(), 1));
        assert_eq!(bytes.len(), 16);
        for (i, &v) in data.iter().enumerate() {
            let w = u32::from_le_bytes(bytes[(i >> 1) * 4..(i >> 1) * 4 + 4].try_into().unwrap());
            let s = if i & 1 == 1 { (w as i32) >> 16 } else { ((w << 16) as i32) >> 16 };
            assert_eq!(s, v as i32, "value {i}");
        }
        // Even counts are uploaded as they are, no copy.
        assert!(matches!(super::slice_bytes(&[1i16, -2]), std::borrow::Cow::Borrowed(_)));
        assert_eq!(super::slice_buffer_size(512, 512), 512 * 512 * 2);
    }

    /// No vblank wait: Mailbox where offered (D3D12, Vulkan), Immediate on
    /// Metal (it offers only Fifo / Immediate), Fifo as the last resort.
    #[test]
    fn present_mode_never_waits_for_vblank_when_it_can() {
        use wgpu::PresentMode::*;
        assert_eq!(super::present_mode_for(&[Fifo, Mailbox, Immediate]), Mailbox);
        assert_eq!(super::present_mode_for(&[Fifo]), Fifo);
        let metal = super::present_mode_for(&[Fifo, Immediate]);
        assert_eq!(metal, if cfg!(target_os = "macos") { Immediate } else { Fifo });
    }

    #[test]
    fn metal_keeps_a_spare_drawable() {
        // macOS: three drawables (latency 2), so a frame never waits for the
        // window server to hand one back; Windows unchanged.
        assert_eq!(super::frame_latency(), if cfg!(target_os = "macos") { 2 } else { 1 });
    }

    /// A frame that draws no image (no cells, or cells not given a slice
    /// yet) is the empty frame whatever the surface size: what a new macOS
    /// surface shows, so it is not presented over one.
    #[test]
    fn a_frame_without_an_image_is_the_empty_frame() {
        use super::{frame_signature, CellState, EMPTY_FRAME};
        use crate::native_view::View;
        let mut cells = std::collections::HashMap::new();
        assert_eq!(frame_signature(&cells, 1440, 900, 1.0), EMPTY_FRAME);
        let rect = super::Cell { x: 0.0, y: 40.0, w: 800.0, h: 600.0 };
        cells.insert("0".to_string(), CellState { rect, series: vec![], plane: None, view: View::default(), gpu: None });
        assert_eq!(frame_signature(&cells, 1440, 900, 1.0), EMPTY_FRAME);
        assert_eq!(frame_signature(&cells, 1, 1, 2.0), EMPTY_FRAME);
        assert_eq!(super::initially_shown(), if cfg!(target_os = "macos") { Some(EMPTY_FRAME) } else { None });
    }

    #[test]
    fn scissor_tiles_neighbours_without_overlap_at_fractional_dpi() {
        for scale in [1.0f32, 1.25, 1.5, 1.75] {
            // Three panes side by side at fractional CSS positions.
            let xs = [0.0f32, 333.4, 666.8, 1000.2];
            let mut prev_end = 0u32;
            for i in 0..3 {
                let (x0, _, w, _) = super::device_clip(xs[i], 10.3, xs[i + 1] - xs[i], 200.6, scale, 4000, 4000).unwrap();
                assert_eq!(x0, prev_end, "pane {i} starts where pane {} ends (scale {scale})", i.wrapping_sub(1));
                prev_end = x0 + w;
            }
        }
        // Clipped to the surface; an off-surface cell has no scissor.
        assert_eq!(super::device_clip(-10.0, -10.0, 50.0, 50.0, 1.0, 30, 30), Some((0, 0, 30, 30)));
        assert_eq!(super::device_clip(40.0, 0.0, 10.0, 10.0, 1.0, 30, 30), None);
    }

    #[test]
    fn test_image_is_a_ramp_with_rings() {
        let px = super::test_image(64);
        assert_eq!(px.len(), 64 * 64);
        // Left edge dark, right edge bright on a row away from the rings' bright bands.
        assert!(px[0] < px[63]);
        assert!(px.iter().any(|&v| v > 25000));
    }

    #[test]
    fn append_series_grows_the_list_and_keeps_the_view() {
        use super::*;
        let native = Native::default();
        let view = View { index: 7, zoom: 2.0, ..View::default() };
        let paths = |r: std::ops::Range<u32>| r.map(|i| PathBuf::from(format!("{i}.dcm"))).collect::<Vec<_>>();
        native.cells.lock().insert(
            "a".into(),
            CellState { rect: Cell::default(), series: paths(0..10), plane: None, view, gpu: None },
        );
        // A batch that extends what Rust holds is appended, view untouched.
        assert_eq!(native.append_series("a", 10, paths(10..25)), Some(25));
        {
            let cells = native.cells.lock();
            let c = &cells["a"];
            assert_eq!(c.series.len(), 25);
            assert_eq!(c.series[24], PathBuf::from("24.dcm"));
            assert_eq!(c.view, view);
        }
        // A stale `from` (the list changed underneath) is refused, not spliced.
        assert_eq!(native.append_series("a", 10, paths(10..12)), None);
        assert_eq!(native.cells.lock()["a"].series.len(), 25);
        // Unknown cell.
        assert_eq!(native.append_series("b", 0, paths(0..1)), None);
        // The store was never touched: an append decodes nothing.
        assert!(native.store.get().is_none());
    }
}

#[cfg(test)]
mod roi_tests {
    use super::*;

    fn slice() -> Slice {
        // 10×10, value = column index; 0.5 mm × 2 mm pixels.
        Slice { rows: 10, cols: 10, data: (0..100).map(|i| (i % 10) as i16).collect(), window: None, spacing: [0.5, 2.0] }
    }

    #[test]
    fn rect_stats_and_area() {
        let st = roi_stats(&slice(), &RoiShape::Rect { a: (2.0, 0.0), b: (4.0, 10.0) });
        assert_eq!(st.pixels, 20);
        assert!((st.mean - 2.5).abs() < 1e-9);
        assert_eq!((st.min, st.max), (2.0, 3.0));
        assert!((st.area_mm2 - 20.0).abs() < 1e-9);
    }

    #[test]
    fn ellipse_and_polygon_are_inside_their_box() {
        let s = slice();
        let e = roi_stats(&s, &RoiShape::Ellipse { a: (0.0, 0.0), b: (10.0, 10.0) });
        assert!(e.pixels > 60 && e.pixels < 100, "{}", e.pixels);
        let tri = roi_stats(&s, &RoiShape::Polygon { points: vec![(0.0, 0.0), (10.0, 0.0), (0.0, 10.0)] });
        assert!(tri.pixels > 40 && tri.pixels < 60, "{}", tri.pixels);
        assert!(tri.mean < 4.5);
    }
}
