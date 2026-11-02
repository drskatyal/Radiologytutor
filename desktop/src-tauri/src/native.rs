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

/// The P2 path is opt-in until P2.6 (cutover).
pub fn enabled() -> bool {
    crate::flowrad_env("NATIVE").as_deref() == Ok("1")
}

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
    /// Last frame: CPU time to record + submit (not GPU time).
    pub last_frame_ms: Option<f64>,
    pub frames: u64,
    /// Window client-area origin on screen, physical px (for the e2e grab).
    pub client_origin: Option<(i32, i32)>,
    pub scale: Option<f64>,
    /// Native viewports alive.
    pub cells: usize,
}

const TEST_SIZE: u32 = 512;
/// The spike view's single cell.
pub const SPIKE: &str = "spike";

/// One cell's GPU side: its uniforms and the texture on screen.
struct CellGpu {
    uniforms: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    /// (path, texture) of the slice uploaded, None = the test image.
    texture: Option<(PathBuf, wgpu::Texture)>,
    dims: (usize, usize),
}

/// One viewport.
struct CellState {
    rect: Cell,
    series: Vec<PathBuf>,
    view: View,
    gpu: Option<CellGpu>,
}

struct Gpu {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    test_view: wgpu::TextureView,
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
}

pub type Shared = Arc<Native>;

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
@group(0) @binding(1) var img: texture_2d<i32>;

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
  let s = f32(textureLoad(img, vec2<i32>(q), 0).r);
  let lo = u.wl.x - u.wl.y * 0.5;
  var g = clamp((s - lo) / max(u.wl.y, 1.0), 0.0, 1.0);
  if (u.xf.w > 0.5) { g = 1.0 - g; }
  return vec4(g, g, g, 1.0);
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
    pub total_ms: f64,
    pub rows: usize,
    pub cols: usize,
    pub window: (f32, f32),
    pub view: View,
    /// Image ↔ cell (CSS px), for overlays.
    pub transform: Transform,
    /// The file's own window (for "reset").
    pub default_window: Option<(f64, f64)>,
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
        s.cells = self.cells.lock().len();
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
                let mut s = self.status.lock();
                s.ready = true;
                s.adapter = Some(adapter);
                s.backend = Some(backend);
                s.error = None;
                s.init_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
            }
            Err(e) => self.status.lock().error = Some(e),
        }
        self.status()
    }

    pub fn resize(&self, width: u32, height: u32) {
        if let Some(gpu) = self.gpu.lock().as_mut() {
            if width > 0 && height > 0 && (gpu.config.width != width || gpu.config.height != height) {
                gpu.config.width = width;
                gpu.config.height = height;
                gpu.surface.configure(&gpu.device, &gpu.config);
            }
        }
    }

    pub fn set_window_facts(&self, origin: (i32, i32), scale: f64) {
        let mut s = self.status.lock();
        s.client_origin = Some(origin);
        s.scale = Some(scale);
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
                .or_insert(CellState { rect, series: vec![], view: View::default(), gpu: None });
        }
    }

    /// Spike (P2.0): one cell showing the test image.
    pub fn set_cells(&self, rects: Vec<Cell>) {
        let first = rects.first().copied().unwrap_or_default();
        let mut cells = self.cells.lock();
        let c = cells.entry(SPIKE.to_string()).or_insert(CellState {
            rect: first,
            series: vec![],
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
    pub fn set_series(&self, id: &str, paths: Vec<PathBuf>, index: usize, scale: f64) -> Result<ShowResult, String> {
        {
            let mut cells = self.cells.lock();
            let c = cells.entry(id.to_string()).or_insert(CellState { rect: Cell::default(), series: vec![], view: View::default(), gpu: None });
            c.series = paths;
            c.view = View { index: index.min(c.series.len().saturating_sub(1)), ..View::default() };
        }
        self.show(id, None, true, scale)
    }

    /// Apply a view change (any of slice, window, zoom, pan, rotation, flip, invert).
    pub fn update_view(&self, id: &str, patch: ViewPatch, scale: f64) -> Result<ShowResult, String> {
        self.show(id, Some(patch), false, scale)
    }

    /// Scroll by `delta` slices (clamped).
    pub fn scroll(&self, id: &str, delta: i64, scale: f64) -> Result<ShowResult, String> {
        let at = {
            let cells = self.cells.lock();
            let c = cells.get(id).ok_or("no such viewport")?;
            if c.series.is_empty() {
                return Err("no series in this viewport".into());
            }
            (c.view.index as i64 + delta).clamp(0, c.series.len() as i64 - 1) as usize
        };
        self.show(id, Some(ViewPatch { index: Some(at), ..Default::default() }), false, scale)
    }

    /// Free a cell's texture and series (viewport closed or switched to JS).
    pub fn close_cell(&self, id: &str) {
        self.cells.lock().remove(id);
    }

    /// Study closed: every cell and every decoded slice.
    pub fn close_all(&self) {
        self.cells.lock().clear();
        if let Some(store) = self.store.get() {
            store.clear();
        }
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

    fn show(&self, id: &str, patch: Option<ViewPatch>, reset_wl: bool, scale: f64) -> Result<ShowResult, String> {
        let started = Instant::now();
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
        let frame_ms = self.render(scale)?;
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
            total_ms: started.elapsed().as_secs_f64() * 1000.0,
            rows,
            cols,
            window: c.view.wl,
            view: c.view,
            transform: Transform::new(&c.view, cols, rows, c.rect.w, c.rect.h),
            default_window,
        })
    }

    /// Make sure the cell's texture holds `slice` (reused across a series).
    fn upload(&self, id: &str, path: &std::path::Path, slice: &Slice) -> Result<(), String> {
        let guard = self.gpu.lock();
        let gpu = guard.as_ref().ok_or("native renderer not initialised")?;
        let mut cells = self.cells.lock();
        let c = cells.get_mut(id).ok_or("no such viewport")?;
        let cg = c.gpu.get_or_insert_with(|| new_cell_gpu(gpu, &gpu.test_view));
        if cg.texture.as_ref().is_some_and(|(p, _)| p == path) {
            return Ok(());
        }
        let size = wgpu::Extent3d { width: slice.cols as u32, height: slice.rows as u32, depth_or_array_layers: 1 };
        let reuse = cg.texture.take().filter(|(_, t)| t.width() == size.width && t.height() == size.height).map(|(_, t)| t);
        let fresh = reuse.is_none();
        let texture = reuse.unwrap_or_else(|| {
            gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("slice"),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R16Sint,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            })
        });
        // SAFETY: i16 is plain old data; the slice is borrowed for the call.
        let bytes = unsafe { std::slice::from_raw_parts(slice.data.as_ptr() as *const u8, slice.data.len() * 2) };
        gpu.queue.write_texture(
            texture.as_image_copy(),
            bytes,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size.width * 2), rows_per_image: Some(size.height) },
            size,
        );
        if fresh {
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            cg.bind_group = bind_group(gpu, &cg.uniforms, &view);
        }
        cg.texture = Some((path.to_path_buf(), texture));
        cg.dims = (slice.cols, slice.rows);
        Ok(())
    }

    /// Draw every cell. `scale`: physical px per CSS px.
    pub fn render(&self, scale: f64) -> Result<f64, String> {
        let started = Instant::now();
        let mut guard = self.gpu.lock();
        let gpu = guard.as_mut().ok_or("native renderer not initialised")?;
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
        let target = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let (sw, sh) = (gpu.config.width, gpu.config.height);
        let s = scale as f32;
        let mut cells = self.cells.lock();
        // Uniforms first (each cell has its own buffer), then one pass.
        for c in cells.values_mut() {
            let cg = c.gpu.get_or_insert_with(|| new_cell_gpu(gpu, &gpu.test_view));
            let (cols, rows) = if cg.texture.is_some() { cg.dims } else { (TEST_SIZE as usize, TEST_SIZE as usize) };
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
                    view: &target,
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
                if cg.texture.is_none() && id != SPIKE {
                    continue;
                }
                // Clip to the cell and to the surface.
                let x0 = (c.rect.x * s).max(0.0).floor() as u32;
                let y0 = (c.rect.y * s).max(0.0).floor() as u32;
                let x1 = ((c.rect.x + c.rect.w) * s).ceil().max(0.0) as u32;
                let y1 = ((c.rect.y + c.rect.h) * s).ceil().max(0.0) as u32;
                let (x1, y1) = (x1.min(sw), y1.min(sh));
                if x1 <= x0 || y1 <= y0 {
                    continue;
                }
                pass.set_scissor_rect(x0, y0, x1 - x0, y1 - y0);
                pass.set_bind_group(0, &cg.bind_group, &[]);
                pass.draw(0..6, 0..1);
            }
        }
        drop(cells);
        gpu.queue.submit(Some(encoder.finish()));
        gpu.queue.present(frame);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut st = self.status.lock();
        st.last_frame_ms = Some(ms);
        st.frames += 1;
        Ok(ms)
    }

    // ───────────── P2.1 spike API (the spike cell) ─────────────

    pub fn open_series(&self, paths: Vec<PathBuf>, scale: f64) -> Result<ShowResult, String> {
        self.store().clear();
        self.set_series(SPIKE, paths, 0, scale)
    }

    pub fn scroll_spike(&self, delta: i64, scale: f64) -> Result<ShowResult, String> {
        self.scroll(SPIKE, delta, scale)
    }
}

fn bind_group(gpu: &Gpu, uniforms: &wgpu::Buffer, view: &wgpu::TextureView) -> wgpu::BindGroup {
    gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("cell"),
        layout: &gpu.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(view) },
        ],
    })
}

fn new_cell_gpu(gpu: &Gpu, initial: &wgpu::TextureView) -> CellGpu {
    let uniforms = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("cell uniforms"),
        size: 80,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let bind_group = bind_group(gpu, &uniforms, initial);
    CellGpu { uniforms, bind_group, texture: None, dims: (TEST_SIZE as usize, TEST_SIZE as usize) }
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

async fn create_gpu(window: &tauri::WebviewWindow) -> Result<(Gpu, String, String), String> {
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let surface = instance.create_surface(window.as_ref().window()).map_err(|e| format!("surface: {e}"))?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            ..Default::default()
        })
        .await
        .map_err(|e| format!("adapter: {e}"))?;
    let info = adapter.get_info();
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("flowrad-native"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults().using_resolution(adapter.limits()),
            ..Default::default()
        })
        .await
        .map_err(|e| format!("device: {e}"))?;
    let caps = surface.get_capabilities(&adapter);
    let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        width: size.width.max(1),
        height: size.height.max(1),
        present_mode: wgpu::PresentMode::Fifo,
        desired_maximum_frame_latency: 2,
        alpha_mode: caps.alpha_modes[0],
        color_space: wgpu::SurfaceColorSpace::Auto,
        view_formats: vec![],
    };
    surface.configure(&device, &config);

    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("test image"),
        size: wgpu::Extent3d { width: TEST_SIZE, height: TEST_SIZE, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R16Sint,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let pixels = test_image(TEST_SIZE);
    let bytes: Vec<u8> = pixels.iter().flat_map(|v| v.to_le_bytes()).collect();
    queue.write_texture(
        texture.as_image_copy(),
        &bytes,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(TEST_SIZE * 2), rows_per_image: Some(TEST_SIZE) },
        wgpu::Extent3d { width: TEST_SIZE, height: TEST_SIZE, depth_or_array_layers: 1 },
    );
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
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Sint,
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
        ],
    });
    let test_view = texture.create_view(&wgpu::TextureViewDescriptor::default());
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
    Ok((
        Gpu { surface, device, queue, config, pipeline, layout, test_view },
        info.name,
        format!("{:?}", info.backend),
    ))
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_image_is_a_ramp_with_rings() {
        let px = super::test_image(64);
        assert_eq!(px.len(), 64 * 64);
        // Left edge dark, right edge bright on a row away from the rings' bright bands.
        assert!(px[0] < px[63]);
        assert!(px.iter().any(|&v| v > 25000));
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
