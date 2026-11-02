//! Phase 2 (docs/NATIVE_RENDERER.md), step P2.0: a wgpu surface drawn in the
//! window UNDER a transparent WebView2, behind `FLOWRAD_NATIVE=1`.
//!
//! The webview keeps all chrome and input; it reports the rectangles of the
//! viewports ("cells", CSS px of the page) and Rust draws into them with the
//! GPU. Where the page is transparent the native pixels show through; where it
//! draws (toolbar, overlays, menus) it covers them.
//!
//! P2.0 is the spike: one test image (a 16-bit ramp + rings, R16Uint texture,
//! window/level applied in the shader) drawn into every cell. It proves the
//! compositing, the window/level path and the IPC cost, and it lets the bench
//! measure the WebView2 UI floor with no image engine in the page.

use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// The P2 path is opt-in until P2.6 (cutover).
pub fn enabled() -> bool {
    crate::flowrad_env("NATIVE").as_deref() == Ok("1")
}

/// A viewport rectangle in CSS pixels of the page (its top-left origin is
/// the window's client-area origin: the webview fills the window).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Cell {
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
}

const TEST_SIZE: u32 = 512;

struct Gpu {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    uniforms: wgpu::Buffer,
}

#[derive(Default)]
pub struct Native {
    gpu: Mutex<Option<Gpu>>,
    status: Mutex<NativeStatus>,
    cells: Mutex<Vec<Cell>>,
    /// Window centre / width in stored values of the test image (0..65535).
    wl: Mutex<(f32, f32)>,
}

pub type Shared = Arc<Native>;

/// The 16-bit test image: a horizontal ramp with concentric rings, so window
/// / level visibly changes contrast and an off-by-one in the upload shows.
pub fn test_image(size: u32) -> Vec<u16> {
    let n = size as usize;
    let mut px = vec![0u16; n * n];
    let c = n as f32 / 2.0;
    for y in 0..n {
        for x in 0..n {
            let ramp = x as f32 / (n - 1) as f32;
            let r = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let ring = if (r as usize / 24) % 2 == 0 { 0.0 } else { 0.15 };
            px[y * n + x] = (((ramp * 0.85) + ring).min(1.0) * 65535.0) as u16;
        }
    }
    px
}

const SHADER: &str = r#"
struct U {
  // x, y, w, h of the cell in NDC-space pixels of the surface; then wl centre, wl width (stored units), surface w, h
  rect: vec4<f32>,
  wl: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var img: texture_2d<u32>;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  // Two triangles covering the cell, in surface pixels -> NDC.
  var corners = array<vec2<f32>, 6>(vec2(0.,0.), vec2(1.,0.), vec2(0.,1.), vec2(0.,1.), vec2(1.,0.), vec2(1.,1.));
  let c = corners[i];
  let px = u.rect.xy + c * u.rect.zw;
  let ndc = vec2(px.x / u.wl.z * 2.0 - 1.0, 1.0 - px.y / u.wl.w * 2.0);
  var o: VOut;
  o.pos = vec4(ndc, 0.0, 1.0);
  o.uv = c;
  return o;
}

@fragment fn fs(v: VOut) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(img));
  // Fit the square image into the cell (contain), black around it.
  let aspect = u.rect.z / u.rect.w;
  var uv = v.uv;
  if (aspect > 1.0) { uv.x = (uv.x - 0.5) * aspect + 0.5; } else { uv.y = (uv.y - 0.5) / aspect + 0.5; }
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return vec4(0.0, 0.0, 0.0, 1.0); }
  let p = vec2<i32>(clamp(uv * dims, vec2(0.0), dims - 1.0));
  let s = f32(textureLoad(img, p, 0).r);
  let lo = u.wl.x - u.wl.y * 0.5;
  let g = clamp((s - lo) / max(u.wl.y, 1.0), 0.0, 1.0);
  return vec4(g, g, g, 1.0);
}
"#;

impl Native {
    pub fn status(&self) -> NativeStatus {
        let mut s = self.status.lock().clone();
        s.enabled = enabled();
        s
    }

    /// Create the surface on the window and the device. Idempotent.
    pub fn init(&self, window: &tauri::WebviewWindow) -> NativeStatus {
        if self.gpu.lock().is_some() || !enabled() {
            return self.status();
        }
        *self.wl.lock() = (32768.0, 65535.0);
        let started = Instant::now();
        match pollster_block(create_gpu(window)) {
            Ok((gpu, adapter, backend)) => {
                *self.gpu.lock() = Some(gpu);
                let mut s = self.status.lock();
                s.ready = true;
                s.adapter = Some(adapter);
                s.backend = Some(backend);
                s.error = None;
                s.init_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
            }
            Err(e) => {
                self.status.lock().error = Some(e);
            }
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

    pub fn set_cells(&self, cells: Vec<Cell>) {
        *self.cells.lock() = cells;
    }

    pub fn set_wl(&self, center: f32, width: f32) {
        *self.wl.lock() = (center, width.max(1.0));
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
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let (center, width) = *self.wl.lock();
        let cells = self.cells.lock().clone();
        let (sw, sh) = (gpu.config.width as f32, gpu.config.height as f32);
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("cells"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        // The app canvas colour behind everything the page does not cover.
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.035, g: 0.04, b: 0.05, a: 1.0 }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&gpu.pipeline);
            pass.set_bind_group(0, &gpu.bind_group, &[]);
            for cell in &cells {
                let s = scale as f32;
                let rect = [cell.x * s, cell.y * s, cell.w * s, cell.h * s];
                if rect[2] < 1.0 || rect[3] < 1.0 {
                    continue;
                }
                // One uniform write per cell is fine for the spike (one queue
                // write lands before the pass executes, so cells share the
                // last value: P2.2 moves to a per-cell buffer). Draw only the
                // first cell's rect with its own uniforms here.
                let data: [f32; 8] = [rect[0], rect[1], rect[2], rect[3], center, width, sw, sh];
                gpu.queue.write_buffer(&gpu.uniforms, 0, bytemuck_cast(&data));
                pass.draw(0..6, 0..1);
                break;
            }
        }
        gpu.queue.submit(Some(encoder.finish()));
        gpu.queue.present(frame);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut s = self.status.lock();
        s.last_frame_ms = Some(ms);
        s.frames += 1;
        Ok(ms)
    }

    pub fn set_window_facts(&self, origin: (i32, i32), scale: f64) {
        let mut s = self.status.lock();
        s.client_origin = Some(origin);
        s.scale = Some(scale);
    }
}

fn bytemuck_cast(data: &[f32; 8]) -> &[u8] {
    // SAFETY: [f32; 8] is 32 plain bytes with no padding.
    unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, std::mem::size_of_val(data)) }
}

fn pollster_block<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
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
        format: wgpu::TextureFormat::R16Uint,
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
    let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("cell uniforms"),
        size: 32,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
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
                    sample_type: wgpu::TextureSampleType::Uint,
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
        ],
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("cell"),
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&texture.create_view(&wgpu::TextureViewDescriptor::default())),
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
    Ok((
        Gpu { surface, device, queue, config, pipeline, bind_group, uniforms },
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
        assert!(px.iter().any(|&v| v > 50000));
    }
}
