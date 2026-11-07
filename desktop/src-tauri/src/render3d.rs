//! Native 3D (volume rendering and MIP) from the shared Rust volume.
//!
//! The 3D view used to hand Cornerstone/VTK a full JS volume plus a GPU volume
//! texture (HP, 0.6.0: blank view, 3.4 GB peak, 1.19 s freeze). Now the same
//! 16-bit volume MPR uses is ray-cast here, on every core, and the webview
//! receives one RGB PNG per frame.
//!
//! Orthographic camera around the volume centre. `yaw` turns about the
//! patient's head-foot axis, `pitch` tilts toward head or feet; (0, 0) is the
//! anterior view with the head up and the patient's left on the right (the
//! radiological convention for a frontal view).
//!
//! Interactive frames use a half-resolution copy of the volume (built once,
//! 1/8 the voxels) and a coarser ray step; the final frame uses the full volume
//! with trilinear sampling. Rays stop early once nearly opaque.

use std::sync::Arc;

use parking_lot::Mutex;
use rayon::prelude::*;

use crate::volume::Volume;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Maximum intensity projection (windowed).
    Mip,
    /// Bone: opaque from ~180 HU, ivory.
    Bone,
    /// Skin and soft tissue: translucent skin, opaque bone.
    Soft,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "mip" => Some(Mode::Mip),
            "bone" => Some(Mode::Bone),
            "soft" => Some(Mode::Soft),
            _ => None,
        }
    }
}

/// A half-resolution copy for interactive frames (2×2×2 mean), keyed by volume.
struct Coarse {
    key: u64,
    dims: [usize; 3],
    data: Vec<i16>,
}

static COARSE: Mutex<Option<Arc<Coarse>>> = Mutex::new(None);

fn coarse_of(v: &Volume) -> Arc<Coarse> {
    if let Some(c) = COARSE.lock().as_ref().filter(|c| c.key == v.key) {
        return c.clone();
    }
    let [nx, ny, nz] = v.dims;
    let (cx, cy, cz) = ((nx / 2).max(1), (ny / 2).max(1), (nz / 2).max(1));
    let mut data = vec![0i16; cx * cy * cz];
    data.par_chunks_mut(cx * cy).enumerate().for_each(|(z, plane)| {
        // Row by row: the (up to) four source rows of each output row, summed
        // pairwise along x. Same integer sum and count as averaging each 2×2×2
        // block voxel by voxel (a block cut by the volume's edge averages the
        // voxels it has), without the per-voxel bounds tests.
        let rows = |y: usize| {
            let mut r: [Option<&[i16]>; 4] = [None; 4];
            for (k, (dz, dy)) in [(0, 0), (0, 1), (1, 0), (1, 1)].into_iter().enumerate() {
                let (sy, sz) = (2 * y + dy, 2 * z + dz);
                if sy < ny && sz < nz {
                    r[k] = Some(&v.data[(sz * ny + sy) * nx..][..nx]);
                }
            }
            r
        };
        for (y, out) in plane.chunks_mut(cx).enumerate() {
            let src = rows(y);
            let rows_in = src.iter().flatten().count() as i32;
            for (x, o) in out.iter_mut().enumerate() {
                let (x0, x1) = (2 * x, 2 * x + 1);
                let (mut sum, mut n) = (0i32, 0i32);
                for row in src.iter().flatten() {
                    sum += row[x0] as i32;
                    if x1 < nx {
                        sum += row[x1] as i32;
                    }
                }
                n += rows_in * if x1 < nx { 2 } else { 1 };
                *o = (sum / n.max(1)) as i16;
            }
        }
    });
    let c = Arc::new(Coarse { key: v.key, dims: [cx, cy, cz], data });
    *COARSE.lock() = Some(c.clone());
    c
}

/// Drop the interactive copy (the volume was released).
pub fn release(key: u64) {
    let mut c = COARSE.lock();
    if c.as_ref().is_some_and(|c| c.key == key) {
        *c = None;
    }
}

struct Grid<'a> {
    dims: [usize; 3],
    data: &'a [i16],
}

impl Grid<'_> {
    #[inline]
    fn at(&self, x: usize, y: usize, z: usize) -> f32 {
        self.data[(z * self.dims[1] + y) * self.dims[0] + x] as f32
    }

    /// Trilinear sample at voxel coordinates (clamped).
    #[inline]
    fn sample(&self, p: [f32; 3]) -> f32 {
        let [nx, ny, nz] = self.dims;
        let fx = p[0].clamp(0.0, (nx - 1) as f32);
        let fy = p[1].clamp(0.0, (ny - 1) as f32);
        let fz = p[2].clamp(0.0, (nz - 1) as f32);
        let (x0, y0, z0) = (fx as usize, fy as usize, fz as usize);
        let (x1, y1, z1) = ((x0 + 1).min(nx - 1), (y0 + 1).min(ny - 1), (z0 + 1).min(nz - 1));
        let (tx, ty, tz) = (fx - x0 as f32, fy - y0 as f32, fz - z0 as f32);
        let c00 = self.at(x0, y0, z0) * (1.0 - tx) + self.at(x1, y0, z0) * tx;
        let c10 = self.at(x0, y1, z0) * (1.0 - tx) + self.at(x1, y1, z0) * tx;
        let c01 = self.at(x0, y0, z1) * (1.0 - tx) + self.at(x1, y0, z1) * tx;
        let c11 = self.at(x0, y1, z1) * (1.0 - tx) + self.at(x1, y1, z1) * tx;
        let c0 = c00 * (1.0 - ty) + c10 * ty;
        let c1 = c01 * (1.0 - ty) + c11 * ty;
        c0 * (1.0 - tz) + c1 * tz
    }
}

/// Soft-tissue preset: the skin is drawn where a ray crosses this level (air ↔
/// tissue), as one translucent layer per crossing. A value band over all soft
/// tissue (0.8.0 / 0.8.1) made the body an opaque brown block hiding the bone,
/// and a thin band aliased against the sample spacing into speckle.
const SKIN_HU: f32 = -400.0;
const SKIN_ALPHA: f32 = 0.22;
const SKIN_RGB: [f32; 3] = [0.85, 0.55, 0.45];

/// Opacity and colour (linear 0–1) of a value for a preset.
#[inline]
fn transfer(mode: Mode, hu: f32) -> (f32, [f32; 3]) {
    let ramp = |lo: f32, hi: f32| ((hu - lo) / (hi - lo)).clamp(0.0, 1.0);
    match mode {
        Mode::Bone => (ramp(180.0, 500.0) * 0.9, [0.93, 0.88, 0.78]),
        // The skin is not a value band but a surface (SKIN_HU in render).
        Mode::Soft => (ramp(200.0, 500.0) * 0.9, [0.95, 0.92, 0.85]),
        Mode::Mip => (0.0, [0.0; 3]),
    }
}

fn rotate(yaw: f32, pitch: f32) -> ([f32; 3], [f32; 3], [f32; 3]) {
    // Patient (LPS-ish) axes of the volume grid: +x left, +y posterior, +z head.
    // Anterior view: look along +y, right = +x, up = +z.
    let (sy, cy) = yaw.sin_cos();
    let (sp, cp) = pitch.sin_cos();
    // Yaw about z, then pitch about the rotated right axis.
    let dir0 = [-sy, cy, 0.0];
    let right = [cy, sy, 0.0];
    let up0 = [0.0, 0.0, 1.0];
    let dir = [dir0[0] * cp - up0[0] * sp, dir0[1] * cp - up0[1] * sp, dir0[2] * cp - up0[2] * sp];
    let up = [up0[0] * cp + dir0[0] * sp, up0[1] * cp + dir0[1] * sp, up0[2] * cp + dir0[2] * sp];
    (dir, right, up)
}

/// Deterministic per-pixel offset in [0, 1) (integer hash; same frame every time).
#[inline]
fn jitter(x: usize, y: usize) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x9E37_79B1) ^ (y as u32).wrapping_mul(0x85EB_CA77);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    (h >> 8) as f32 / (1u32 << 24) as f32
}

pub struct Frame {
    pub w: usize,
    pub h: usize,
    pub rgb: Vec<u8>,
}

/// Render one frame. `size` is the long side in pixels; `fast` selects the
/// interactive path (half-resolution volume, nearest step 1 coarse voxel).
#[allow(clippy::too_many_arguments)]
pub fn render(v: &Volume, mode: Mode, yaw: f32, pitch: f32, zoom: f32, center: f32, width: f32, size: usize, fast: bool) -> Frame {
    let coarse;
    let (grid, scale) = if fast {
        coarse = coarse_of(v);
        (Grid { dims: coarse.dims, data: &coarse.data }, 2.0f32)
    } else {
        (Grid { dims: v.dims, data: &v.data }, 1.0f32)
    };
    let [nx, ny, nz] = grid.dims;
    // Voxel size in mm for this grid.
    let sp = [v.spacing[0] as f32 * scale, v.spacing[1] as f32 * scale, v.spacing[2] as f32 * scale];
    let ext = [nx as f32 * sp[0], ny as f32 * sp[1], nz as f32 * sp[2]];
    let centre = [ext[0] / 2.0, ext[1] / 2.0, ext[2] / 2.0];
    let diag = (ext[0] * ext[0] + ext[1] * ext[1] + ext[2] * ext[2]).sqrt();
    let (dir, right, up) = rotate(yaw, pitch);
    let view = diag / zoom.max(0.1);
    let (w, h) = (size.max(16), size.max(16));
    let step = sp[0].min(sp[1]).min(sp[2]).max(0.2);
    let lower = center - width / 2.0;
    let wl = |val: f32| ((val - lower) / width.max(1.0)).clamp(0.0, 1.0);
    let mut rgb = vec![0u8; w * h * 3];
    rgb.par_chunks_mut(w * 3).enumerate().for_each(|(py, row)| {
        for px in 0..w {
            let u = ((px as f32 + 0.5) / w as f32 - 0.5) * view;
            let t = (0.5 - (py as f32 + 0.5) / h as f32) * view;
            // Ray origin on the near side of the bounding sphere.
            let o = [
                centre[0] + right[0] * u + up[0] * t - dir[0] * diag / 2.0,
                centre[1] + right[1] * u + up[1] * t - dir[1] * diag / 2.0,
                centre[2] + right[2] * u + up[2] * t - dir[2] * diag / 2.0,
            ];
            // Slab intersection with the volume box.
            let (mut t0, mut t1) = (0.0f32, diag);
            let mut hit = true;
            for a in 0..3 {
                if dir[a].abs() < 1e-6 {
                    if o[a] < 0.0 || o[a] > ext[a] {
                        hit = false;
                    }
                } else {
                    let (mut ta, mut tb) = ((0.0 - o[a]) / dir[a], (ext[a] - o[a]) / dir[a]);
                    if ta > tb {
                        std::mem::swap(&mut ta, &mut tb);
                    }
                    t0 = t0.max(ta);
                    t1 = t1.min(tb);
                }
            }
            let out = &mut row[px * 3..px * 3 + 3];
            if !hit || t0 >= t1 {
                continue;
            }
            let to_voxel = |s: f32| {
                [
                    (o[0] + dir[0] * s) / sp[0] - 0.5,
                    (o[1] + dir[1] * s) / sp[1] - 0.5,
                    (o[2] + dir[2] * s) / sp[2] - 0.5,
                ]
            };
            // Start each ray a pixel-dependent fraction of a step in: with every
            // ray sampling at the same depths, faint surfaces (skin band, table,
            // blanket) alias into horizontal "wood-grain" stripes across the
            // background (HP 0.8.0). The offset turns that into fine noise.
            let mut s = t0 + step * jitter(px, py);
            if mode == Mode::Mip {
                let mut best = f32::MIN;
                while s < t1 {
                    best = best.max(grid.sample(to_voxel(s)));
                    s += step;
                }
                let g = (wl(best) * 255.0) as u8;
                out.copy_from_slice(&[g, g, g]);
                continue;
            }
            // Front-to-back compositing with simple gradient shading.
            let (mut acc, mut col) = (0.0f32, [0.0f32; 3]);
            let mut prev: Option<f32> = None;
            while s < t1 && acc < 0.97 {
                let p = to_voxel(s);
                let val = grid.sample(p);
                if mode == Mode::Soft {
                    // Skin: one layer where the ray crosses air ↔ tissue, shaded
                    // by the surface normal; weak gradients (noise) are ignored.
                    if prev.is_some_and(|q| (q < SKIN_HU) != (val < SKIN_HU)) {
                        // A wide (±2 voxel) stencil: tissue noise would
                        // otherwise speckle the shading of a smooth skin.
                        let g = [
                            grid.sample([p[0] + 2.0, p[1], p[2]]) - grid.sample([p[0] - 2.0, p[1], p[2]]),
                            grid.sample([p[0], p[1] + 2.0, p[2]]) - grid.sample([p[0], p[1] - 2.0, p[2]]),
                            grid.sample([p[0], p[1], p[2] + 2.0]) - grid.sample([p[0], p[1], p[2] - 2.0]),
                        ];
                        let len = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
                        if len > 400.0 {
                            let lambert = (-(g[0] * dir[0] + g[1] * dir[1] + g[2] * dir[2]) / len).abs();
                            let wgt = (1.0 - acc) * SKIN_ALPHA;
                            for k in 0..3 {
                                col[k] += wgt * SKIN_RGB[k] * (0.35 + 0.65 * lambert);
                            }
                            acc += wgt;
                        }
                    }
                    prev = Some(val);
                }
                // Classify on the 7-point neighbourhood mean, not the single
                // sample: quantum noise in soft tissue (σ 100+ HU on thin
                // slices) crosses the bone threshold voxel by voxel, and a few
                // hundred specks per ray summed into a grainy, slice-striped
                // block behind the bone (HP 0.8.1). The six neighbours are the
                // gradient taps we need anyway, so a sample only pays for them
                // when its raw value is a candidate.
                if transfer(mode, val).0 <= 0.002 {
                    s += step;
                    continue;
                }
                let n = [
                    grid.sample([p[0] + 1.0, p[1], p[2]]),
                    grid.sample([p[0] - 1.0, p[1], p[2]]),
                    grid.sample([p[0], p[1] + 1.0, p[2]]),
                    grid.sample([p[0], p[1] - 1.0, p[2]]),
                    grid.sample([p[0], p[1], p[2] + 1.0]),
                    grid.sample([p[0], p[1], p[2] - 1.0]),
                ];
                let smooth = (val + n.iter().sum::<f32>()) / 7.0;
                let (a, c) = transfer(mode, smooth);
                if a > 0.002 {
                    let g = [n[0] - n[1], n[2] - n[3], n[4] - n[5]];
                    let len = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt().max(1e-3);
                    // Headlight: light along the view direction.
                    let lambert = (-(g[0] * dir[0] + g[1] * dir[1] + g[2] * dir[2]) / len).abs();
                    let shade = 0.25 + 0.75 * lambert;
                    // Opacity per unit length (step-size independent).
                    let a = 1.0 - (1.0 - a).powf(step / 1.0);
                    let wgt = (1.0 - acc) * a;
                    for k in 0..3 {
                        col[k] += wgt * c[k] * shade;
                    }
                    acc += wgt;
                }
                s += step;
            }
            for k in 0..3 {
                out[k] = (col[k].clamp(0.0, 1.0) * 255.0) as u8;
            }
        }
    });
    Frame { w, h, rgb }
}

pub fn png_rgb(f: &Frame) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(f.rgb.len() / 3);
    {
        let mut enc = png::Encoder::new(&mut out, f.w as u32, f.h as u32);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(&f.rgb).ok()?;
    }
    Some(out)
}

/// `/r/<key>/<mode>/<yaw>/<pitch>/<zoom>/<center>/<width>/<size>/<fast 0|1>` → PNG.
pub fn serve(rest: &str) -> Option<Vec<u8>> {
    let mut p = rest.split('/');
    let key: u64 = p.next()?.parse().ok()?;
    let mode = Mode::parse(p.next()?)?;
    let num = |s: Option<&str>| s.and_then(|s| s.parse::<f32>().ok());
    let yaw = num(p.next())?;
    let pitch = num(p.next())?;
    let zoom = num(p.next())?;
    let center = num(p.next())?;
    let width = num(p.next())?;
    let size = (num(p.next())? as usize).clamp(32, 1024);
    let fast = p.next() == Some("1");
    let v = crate::volume::current(key)?;
    png_rgb(&render(&v, mode, yaw, pitch, zoom, center, width, size, fast))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sphere(n: usize) -> Volume {
        let mut data = vec![-1000i16; n * n * n];
        let c = n as f32 / 2.0;
        for z in 0..n {
            for y in 0..n {
                for x in 0..n {
                    let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2) + (z as f32 - c).powi(2)).sqrt();
                    if d < n as f32 / 4.0 {
                        data[(z * n + y) * n + x] = 1000;
                    }
                }
            }
        }
        Volume { key: 99, dims: [n, n, n], spacing: [1.0, 1.0, 1.0], data, min: -1000, max: 1000, window: None, reduced: [1, 1] }
    }

    /// The row-wise half-resolution copy equals the voxel-by-voxel 2×2×2
    /// mean it replaced, including odd and tiny sizes (blocks cut by an edge).
    #[test]
    fn coarse_copy_matches_the_blockwise_mean() {
        let mut key = 1000;
        for dims in [[7usize, 5, 3], [8, 8, 8], [1, 1, 1], [1, 4, 5], [9, 1, 2], [33, 17, 11]] {
            let [nx, ny, nz] = dims;
            let mut seed = 0x9E37_79B9u32 ^ (nx * 31 + ny * 7 + nz) as u32;
            let data: Vec<i16> = (0..nx * ny * nz)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    (seed % 65536) as u16 as i16
                })
                .collect();
            key += 1;
            let v = Volume { key, dims, spacing: [1.0, 1.0, 1.0], data, min: i16::MIN, max: i16::MAX, window: None, reduced: [1, 1] };
            let c = coarse_of(&v);
            let (cx, cy, cz) = ((nx / 2).max(1), (ny / 2).max(1), (nz / 2).max(1));
            assert_eq!(c.dims, [cx, cy, cz]);
            for z in 0..cz {
                for y in 0..cy {
                    for x in 0..cx {
                        let (mut sum, mut n) = (0i32, 0i32);
                        for (dx, dy, dz) in (0..8).map(|i| (i & 1, (i >> 1) & 1, i >> 2)) {
                            let (sx, sy, sz) = (2 * x + dx, 2 * y + dy, 2 * z + dz);
                            if sx < nx && sy < ny && sz < nz {
                                sum += v.data[(sz * ny + sy) * nx + sx] as i32;
                                n += 1;
                            }
                        }
                        assert_eq!(c.data[(z * cy + y) * cx + x], (sum / n.max(1)) as i16, "{dims:?} at {x},{y},{z}");
                    }
                }
            }
            release(key);
        }
    }

    #[test]
    fn bone_render_shows_the_sphere_and_not_the_corners() {
        let v = sphere(48);
        for fast in [false, true] {
            let f = render(&v, Mode::Bone, 0.4, 0.2, 1.0, 0.0, 1.0, 64, fast);
            let centre = &f.rgb[(32 * 64 + 32) * 3..(32 * 64 + 32) * 3 + 3];
            let corner = &f.rgb[0..3];
            assert!(centre[0] > 60, "sphere visible (fast={fast}): {centre:?}");
            assert_eq!(corner, &[0, 0, 0], "background black (fast={fast})");
        }
    }

    #[test]
    fn mip_is_windowed() {
        let v = sphere(32);
        let f = render(&v, Mode::Mip, 0.0, 0.0, 1.0, 0.0, 2000.0, 32, false);
        let centre = f.rgb[(16 * 32 + 16) * 3];
        assert!(centre > 200, "max of the sphere is near white: {centre}");
    }

    #[test]
    fn ray_start_jitter_is_in_one_step_and_spread() {
        let mut sum = 0.0f64;
        let mut row = [0usize; 4];
        for y in 0..64 {
            for x in 0..64 {
                let j = jitter(x, y);
                assert!((0.0..1.0).contains(&j));
                sum += j as f64;
                row[(j * 4.0) as usize] += 1;
            }
        }
        let mean = sum / 4096.0;
        assert!((mean - 0.5).abs() < 0.03, "mean {mean}");
        // Neighbouring rows do not share one offset (that would be a stripe).
        assert!(row.iter().all(|&n| n > 800), "quartiles {row:?}");
        assert_ne!(jitter(10, 3), jitter(10, 4));
        assert_eq!(jitter(7, 9), jitter(7, 9), "deterministic");
    }

    /// A thin-slice body CT: a soft-tissue cylinder (40 HU) with realistic
    /// quantum noise (σ ≈ 70 HU, z-correlated in pairs of slices like a
    /// reconstruction kernel), a bone rod down the middle, noisy air outside.
    fn noisy_body() -> Volume {
        let (nx, ny, nz) = (64usize, 64usize, 40usize);
        let mut data = vec![0i16; nx * ny * nz];
        let noise = |x: usize, y: usize, z: usize| -> f32 {
            // Sum of four hashed uniforms ≈ Gaussian, σ ≈ 1.
            (0..4u32).map(|k| jitter(x * 7 + k as usize * 131, y * 13 + (z / 2) * 977 + k as usize * 17) - 0.5).sum::<f32>() * 1.73
        };
        let c = 31.5f32;
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let r = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
                    let v = if r < 4.0 {
                        900.0
                    } else if r < 26.0 {
                        40.0 + 130.0 * noise(x, y, z)
                    } else {
                        -1000.0 + 20.0 * noise(x, y, z)
                    };
                    data[(z * ny + y) * nx + x] = v as i16;
                }
            }
        }
        Volume { key: 98, dims: [nx, ny, nz], spacing: [0.7, 0.7, 1.0], data, min: -1100, max: 900, window: None, reduced: [1, 1] }
    }

    /// Mean and standard deviation of the luminance in the body between the
    /// rod and the skin: tissue the bone preset must leave black.
    fn body_background(f: &Frame) -> (f64, f64) {
        let mut vals = Vec::new();
        let mid = f.w / 2;
        for y in f.h / 2 - f.h / 6..f.h / 2 + f.h / 6 {
            for x in 0..f.w {
                let dx = (x as isize - mid as isize).unsigned_abs();
                if dx > f.w / 8 && dx < f.w / 5 {
                    let p = &f.rgb[(y * f.w + x) * 3..(y * f.w + x) * 3 + 3];
                    vals.push((p[0] as f64 + p[1] as f64 + p[2] as f64) / 3.0);
                }
            }
        }
        let mean = vals.iter().sum::<f64>() / vals.len() as f64;
        let var = vals.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / vals.len() as f64;
        (mean, var.sqrt())
    }

    /// HP 0.8.1: a noisy, stripy block filled the body behind the bone render.
    /// Noise in soft tissue crossed the bone threshold voxel by voxel, and over
    /// a few hundred samples per ray those specks summed into a grainy slab.
    #[test]
    fn noisy_soft_tissue_stays_black_behind_bone() {
        let v = noisy_body();
        for fast in [false, true] {
            let f = render(&v, Mode::Bone, 0.0, 0.0, 1.0, 0.0, 1.0, 128, fast);
            let (mean, sd) = body_background(&f);
            assert!(mean < 2.0 && sd < 4.0, "body background (fast={fast}): mean {mean:.2}, sd {sd:.2}");
            let rod = &f.rgb[(64 * 128 + 64) * 3..(64 * 128 + 64) * 3 + 3];
            assert!(rod[0] > 60, "the rod still renders (fast={fast}): {rod:?}");
        }
    }

    /// The soft-tissue preset shows the skin as a translucent shell, not the
    /// whole body as an opaque block hiding the bone.
    #[test]
    fn soft_preset_skin_is_a_shell_not_a_block() {
        let v = noisy_body();
        let f = render(&v, Mode::Soft, 0.0, 0.0, 1.0, 0.0, 1.0, 128, false);
        let rod = &f.rgb[(64 * 128 + 64) * 3..(64 * 128 + 64) * 3 + 3];
        // Bone is near white-ish; skin is warm (red > blue). Seen through the
        // shell, the rod keeps most of its brightness and its blue channel.
        assert!(rod[2] > 100, "rod visible through the skin: {rod:?}");
        // Shading over the curved shell varies smoothly; speckle is pixel to
        // pixel: the mean absolute step between horizontal neighbours.
        let mut steps = Vec::new();
        for y in 48..80 {
            // Between the rod and the silhouette, both sides.
            for x in (40..48).chain(81..89) {
                let i = (y * 128 + x) * 3;
                steps.push((f.rgb[i] as f64 - f.rgb[i + 3] as f64).abs());
            }
        }
        let speckle = steps.iter().sum::<f64>() / steps.len() as f64;
        eprintln!("soft speckle {speckle:.2}");
        if let Ok(out) = crate::flowrad_env("TEST_OUT") {
            std::fs::write(format!("{out}/3d-noisy-soft.png"), png_rgb(&f).unwrap()).unwrap();
        }
        assert!(speckle < 3.0, "no speckle in the soft tissue: {speckle:.2}");
    }
}

#[cfg(test)]
mod real {
    /// FLOWRAD_TEST_CT=… cargo test --release render3d::real -- --nocapture
    #[test]
    fn renders_a_real_ct_fast_and_full() {
        let Ok(dir) = crate::flowrad_env("TEST_CT") else { return };
        let _serial = crate::volume::TEST_LOCK.lock();
        let paths: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).collect();
        let info = crate::volume::build(paths).unwrap();
        let v = crate::volume::current(info.key.parse().unwrap()).unwrap();
        for (mode, fast, size) in [(super::Mode::Bone, true, 384), (super::Mode::Bone, false, 768), (super::Mode::Mip, true, 384), (super::Mode::Soft, false, 768)] {
            let t = std::time::Instant::now();
            let f = super::render(&v, mode, 0.3, 0.1, 1.0, 40.0, 400.0, size, fast);
            let lit = f.rgb.chunks(3).filter(|p| p[0] > 20).count();
            eprintln!("{mode:?} fast={fast} {size}px: {:?}, lit {:.0}%", t.elapsed(), 100.0 * lit as f64 / (f.w * f.h) as f64);
            assert!(lit > f.w * f.h / 50, "{mode:?} renders something");
            if let Ok(out) = crate::flowrad_env("TEST_OUT") {
                let png = super::png_rgb(&f).unwrap();
                std::fs::write(format!("{out}/3d-{mode:?}-{fast}.png"), png).unwrap();
            }
        }
        crate::volume::close();
    }
}
