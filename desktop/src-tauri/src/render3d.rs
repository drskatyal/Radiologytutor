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
        for y in 0..cy {
            for x in 0..cx {
                let mut sum = 0i32;
                let mut n = 0i32;
                for dz in 0..2 {
                    for dy in 0..2 {
                        for dx in 0..2 {
                            let (sx, sy, sz) = (2 * x + dx, 2 * y + dy, 2 * z + dz);
                            if sx < nx && sy < ny && sz < nz {
                                sum += v.data[(sz * ny + sy) * nx + sx] as i32;
                                n += 1;
                            }
                        }
                    }
                }
                plane[y * cx + x] = (sum / n.max(1)) as i16;
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

/// Opacity and colour (linear 0–1) of a value for a preset.
#[inline]
fn transfer(mode: Mode, hu: f32) -> (f32, [f32; 3]) {
    let ramp = |lo: f32, hi: f32| ((hu - lo) / (hi - lo)).clamp(0.0, 1.0);
    match mode {
        Mode::Bone => (ramp(180.0, 500.0) * 0.9, [0.93, 0.88, 0.78]),
        Mode::Soft => {
            let bone = ramp(200.0, 500.0);
            if bone > 0.0 {
                (bone * 0.9, [0.95, 0.92, 0.85])
            } else {
                // Skin / soft tissue band: faint and warm.
                let skin = ramp(-600.0, -300.0) * (1.0 - ramp(150.0, 250.0));
                (skin * 0.03, [0.85, 0.55, 0.45])
            }
        }
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
            let mut s = t0;
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
            while s < t1 && acc < 0.97 {
                let p = to_voxel(s);
                let val = grid.sample(p);
                let (a, c) = transfer(mode, val);
                if a > 0.002 {
                    let g = [
                        grid.sample([p[0] + 1.0, p[1], p[2]]) - grid.sample([p[0] - 1.0, p[1], p[2]]),
                        grid.sample([p[0], p[1] + 1.0, p[2]]) - grid.sample([p[0], p[1] - 1.0, p[2]]),
                        grid.sample([p[0], p[1], p[2] + 1.0]) - grid.sample([p[0], p[1], p[2] - 1.0]),
                    ];
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
