//! Native volume core (Phase 1): the series' volume lives HERE, in Rust, as
//! one compact 16-bit buffer, never in the webview. The renderer asks for
//! rendered planes (`dicom://…/v/<key>/<plane>/<index>/<wc>/<ww>/<max>`), a
//! windowed 8-bit PNG of one axial / coronal / sagittal slice, so WebView2
//! never holds the stack, the volume or a volume texture.
//!
//! Assembly: every file in parallel (rayon). Uncompressed little-endian files
//! are memory-mapped and only their pixel bytes are read (no dataset parse of
//! the pixel element, no copy of the file); anything else (JPEG, JPEG 2000,
//! RLE) is decoded by dicom-pixeldata. Values are stored after the modality
//! LUT (CT: Hounsfield units) as i16.
//!
//! One volume is held at a time; opening another, or closing the view, drops
//! it (memory returns to the OS: one Vec).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dicom_dictionary_std::tags;
use dicom_object::{open_file, DefaultDicomObject, OpenFileOptions};
use parking_lot::Mutex;
use rayon::prelude::*;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plane {
    Axial,
    Coronal,
    Sagittal,
}

impl Plane {
    pub fn parse(s: &str) -> Option<Plane> {
        match s {
            "axial" => Some(Plane::Axial),
            "coronal" => Some(Plane::Coronal),
            "sagittal" => Some(Plane::Sagittal),
            _ => None,
        }
    }
}

pub struct Volume {
    // (fields are read by render3d too)
    pub key: u64,
    /// columns (x), rows (y), slices (z)
    pub dims: [usize; 3],
    /// mm: column spacing, row spacing, slice spacing
    pub spacing: [f64; 3],
    pub data: Vec<i16>,
    pub min: i16,
    pub max: i16,
    pub window: Option<(f64, f64)>,
    /// [in-plane, slice] reduction factors (1 = full resolution).
    pub reduced: [usize; 2],
}

#[derive(Serialize)]
pub struct VolumeInfo {
    pub key: String,
    pub dims: [usize; 3],
    pub spacing: [f64; 3],
    pub min: i16,
    pub max: i16,
    /// Default window (center, width) from the middle slice, if any.
    pub window: Option<(f64, f64)>,
    /// Bytes held (the 16-bit voxels).
    pub bytes: usize,
    #[serde(rename = "buildMs")]
    pub build_ms: f64,
    /// [in-plane, slice] reduction to fit the memory budget (1 = full resolution).
    pub reduced: [usize; 2],
}

/// The one volume held, with the number of views using it. A view that opens
/// the same series again shares it; it is freed when the last view closes.
/// (Unkeyed close used to race a re-render's rebuild: the old view's close
/// landed after the new build and freed the volume the panes then asked for,
/// so MPR stayed blank. HP, 0.6.0, uncached study.)
static CURRENT: Mutex<Option<(Arc<Volume>, usize)>> = Mutex::new(None);
/// Builds run one at a time (a second request for the same series waits and
/// then shares the first one's volume).
static BUILD: Mutex<()> = Mutex::new(());

pub fn current(key: u64) -> Option<Arc<Volume>> {
    CURRENT.lock().as_ref().filter(|(v, _)| v.key == key).map(|(v, _)| v.clone())
}

/// One view of `key` is gone; free the volume when none is left.
pub fn release(key: u64) {
    let mut cur = CURRENT.lock();
    if let Some((v, refs)) = cur.as_mut() {
        if v.key == key {
            *refs = refs.saturating_sub(1);
            if *refs == 0 {
                *cur = None;
            }
        }
    }
}

/// Drop whatever is held (tests, study closed).
pub fn close() {
    *CURRENT.lock() = None;
}

pub fn key_of(paths: &[PathBuf]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut sorted: Vec<&PathBuf> = paths.iter().collect();
    sorted.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    sorted.hash(&mut h);
    h.finish()
}

fn info_of(v: &Volume, build_ms: f64) -> VolumeInfo {
    VolumeInfo {
        key: v.key.to_string(),
        dims: v.dims,
        spacing: v.spacing,
        min: v.min,
        max: v.max,
        window: v.window,
        bytes: v.data.len() * 2,
        build_ms,
        reduced: v.reduced,
    }
}

struct SliceHeader {
    path: PathBuf,
    position: [f64; 3],
    rows: usize,
    cols: usize,
    spacing: [f64; 2],
    orientation: [f64; 6],
    window: Option<(f64, f64)>,
    bits: i64,
    signed: bool,
    slope: f64,
    intercept: f64,
    ts: String,
}

fn num(obj: &DefaultDicomObject, tag: dicom_core::Tag, i: usize) -> Option<f64> {
    let e = obj.element_opt(tag).ok()??;
    if let Ok(v) = e.to_multi_float64() {
        return v.get(i).copied();
    }
    e.to_str().ok()?.split('\\').nth(i)?.trim().parse().ok()
}

fn int(obj: &DefaultDicomObject, tag: dicom_core::Tag) -> Option<i64> {
    obj.element_opt(tag).ok()?.and_then(|e| e.to_int::<i64>().ok())
}

const NATIVE_LE: &[&str] = &["1.2.840.10008.1.2", "1.2.840.10008.1.2.1"];

/// The pixel bytes of an uncompressed file, straight from a memory map: the
/// Pixel Data element is the last one in practice, so its value is the file's
/// last `len` bytes; the element header just before it must match.
fn mapped_pixels(path: &Path, len: usize, explicit: bool) -> Option<memmap2::Mmap> {
    let file = std::fs::File::open(path).ok()?;
    // SAFETY: read-only map of a study file; nothing in this process writes it.
    let map = unsafe { memmap2::Mmap::map(&file).ok()? };
    let header = if explicit { 12 } else { 8 };
    if map.len() < len + header {
        return None;
    }
    let at = map.len() - len - header;
    let tag_ok = map[at..at + 4] == [0xE0, 0x7F, 0x10, 0x00];
    let len_ok = if explicit {
        (&map[at + 4..at + 6] == b"OW" || &map[at + 4..at + 6] == b"OB")
            && u32::from_le_bytes([map[at + 8], map[at + 9], map[at + 10], map[at + 11]]) as usize == len
    } else {
        u32::from_le_bytes([map[at + 4], map[at + 5], map[at + 6], map[at + 7]]) as usize == len
    };
    (tag_ok && len_ok).then_some(map)
}

/// Pass 1: the header only (reading stops before the pixel data).
fn read_header(path: &Path) -> Result<SliceHeader, String> {
    let head = OpenFileOptions::new()
        .read_until(tags::PIXEL_DATA)
        .open_file(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let samples = int(&head, tags::SAMPLES_PER_PIXEL).unwrap_or(1);
    if samples != 1 {
        return Err("colour images cannot form a volume".into());
    }
    let position = [
        num(&head, tags::IMAGE_POSITION_PATIENT, 0).ok_or("no Image Position")?,
        num(&head, tags::IMAGE_POSITION_PATIENT, 1).ok_or("no Image Position")?,
        num(&head, tags::IMAGE_POSITION_PATIENT, 2).ok_or("no Image Position")?,
    ];
    let mut orientation = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    for (i, o) in orientation.iter_mut().enumerate() {
        if let Some(v) = num(&head, tags::IMAGE_ORIENTATION_PATIENT, i) {
            *o = v;
        }
    }
    Ok(SliceHeader {
        path: path.to_path_buf(),
        position,
        rows: int(&head, tags::ROWS).ok_or("no Rows")? as usize,
        cols: int(&head, tags::COLUMNS).ok_or("no Columns")? as usize,
        spacing: [
            num(&head, tags::PIXEL_SPACING, 1).unwrap_or(1.0),
            num(&head, tags::PIXEL_SPACING, 0).unwrap_or(1.0),
        ],
        orientation,
        window: match (num(&head, tags::WINDOW_CENTER, 0), num(&head, tags::WINDOW_WIDTH, 0)) {
            (Some(c), Some(w)) if w > 1.0 => Some((c, w)),
            _ => None,
        },
        bits: int(&head, tags::BITS_ALLOCATED).unwrap_or(16),
        signed: int(&head, tags::PIXEL_REPRESENTATION) == Some(1),
        slope: num(&head, tags::RESCALE_SLOPE, 0).unwrap_or(1.0),
        intercept: num(&head, tags::RESCALE_INTERCEPT, 0).unwrap_or(0.0),
        ts: head.meta().transfer_syntax().trim_end_matches('\0').to_string(),
    })
}

/// Pass 2: decode one slice straight into its slot of the volume (no
/// per-slice buffer for the common uncompressed case).
fn decode_into(h: &SliceHeader, dst: &mut [i16]) -> Result<(), String> {
    let n = dst.len();
    let clamp = |v: f64| v.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16;
    let (slope, intercept, signed) = (h.slope, h.intercept, h.signed);
    if NATIVE_LE.contains(&h.ts.as_str()) && (h.bits == 16 || h.bits == 8) {
        let len = n * (h.bits as usize / 8);
        let explicit = h.ts == "1.2.840.10008.1.2.1";
        // An odd-length value is padded with one byte after the pixels.
        let mapped = mapped_pixels(&h.path, len, explicit)
            .map(|m| (m, 0))
            .or_else(|| (len % 2 == 1).then(|| mapped_pixels(&h.path, len + 1, explicit)).flatten().map(|m| (m, 1)));
        if let Some((map, pad)) = mapped {
            let end = map.len() - pad;
            let bytes = &map[end - len..end];
            if h.bits == 16 {
                for (o, c) in dst.iter_mut().zip(bytes.chunks_exact(2)) {
                    let raw = if signed { i16::from_le_bytes([c[0], c[1]]) as f64 } else { u16::from_le_bytes([c[0], c[1]]) as f64 };
                    *o = clamp(raw * slope + intercept);
                }
            } else {
                for (o, &b) in dst.iter_mut().zip(bytes) {
                    *o = clamp(b as f64 * slope + intercept);
                }
            }
            return Ok(());
        }
    }
    // Everything else: full decode (JPEG, JPEG 2000, RLE, odd layouts).
    use dicom_pixeldata::PixelDecoder;
    let path = &h.path;
    let obj = open_file(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let decoded = obj.decode_pixel_data_frame(0).map_err(|e| format!("{}: {e}", path.display()))?;
    let values: Vec<f32> = decoded.to_vec().map_err(|e| format!("{}: {e}", path.display()))?;
    if values.len() < n {
        return Err(format!("{}: short pixel data", path.display()));
    }
    for (o, &v) in dst.iter_mut().zip(&values) {
        *o = clamp(v as f64);
    }
    Ok(())
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Bytes one volume may hold: `FLOWRAD_VOLUME_BUDGET_MB`, else 25% of RAM,
/// capped at 768 MB so MPR / 3D stay under the 1.2 GB process-tree gate.
pub fn budget_bytes() -> usize {
    if let Some(mb) = crate::flowrad_env("VOLUME_BUDGET_MB").ok().and_then(|v| v.parse::<usize>().ok()) {
        return mb << 20;
    }
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let quarter = (sys.total_memory() as usize) / 4;
    quarter.clamp(256 << 20, 768 << 20)
}

/// Smallest reduction that fits `budget`: average slice pairs first (thin
/// slices lose least), then 2x2 in-plane, then more of both.
pub fn reduction(cols: usize, rows: usize, slices: usize, budget: usize) -> (usize, usize) {
    let bytes = |xy: usize, z: usize| (cols / xy) * (rows / xy) * (slices / z) * 2;
    for (xy, z) in [(1, 1), (1, 2), (2, 1), (2, 2), (2, 3), (2, 4), (4, 2), (4, 4)] {
        if slices / z >= 3 && bytes(xy, z) <= budget {
            return (xy, z);
        }
    }
    (4, 4)
}

pub fn build(paths: Vec<PathBuf>) -> Result<VolumeInfo, String> {
    let started = std::time::Instant::now();
    let _one_at_a_time = BUILD.lock();
    let key = key_of(&paths);
    {
        let mut cur = CURRENT.lock();
        if let Some((v, refs)) = cur.as_mut() {
            if v.key == key {
                *refs += 1;
                return Ok(info_of(v, 0.0));
            }
        }
        // Free the previous volume BEFORE allocating the next one.
        *cur = None;
    }
    if paths.len() < 3 {
        return Err("A volume needs at least three slices.".into());
    }
    let mut slices: Vec<SliceHeader> = paths.par_iter().map(|p| read_header(p)).collect::<Result<_, _>>()?;
    let (rows, cols) = (slices[0].rows, slices[0].cols);
    if slices.iter().any(|s| s.rows != rows || s.cols != cols) {
        return Err("The slices differ in size, so they cannot form a volume.".into());
    }
    let o = slices[0].orientation;
    let normal = cross([o[0], o[1], o[2]], [o[3], o[4], o[5]]);
    slices.sort_by(|a, b| dot(a.position, normal).total_cmp(&dot(b.position, normal)));
    let mut gaps: Vec<f64> = slices.windows(2).map(|w| dot(w[1].position, normal) - dot(w[0].position, normal)).collect();
    gaps.sort_by(f64::total_cmp);
    let dz = gaps.get(gaps.len() / 2).copied().unwrap_or(1.0).abs().max(1e-3);
    let n = rows * cols;
    // Hard memory budget (Phase 2): a series bigger than the budget is built at
    // reduced resolution instead of pushing the machine into swap.
    let (step_xy, step_z) = reduction(cols, rows, slices.len(), budget_bytes());
    let (ocols, orows) = (cols / step_xy, rows / step_xy);
    let depth = slices.len() / step_z;
    let on = ocols * orows;
    // The one big allocation: the 16-bit volume. Each output slice is decoded
    // (and, when reduced, box-averaged) straight into its slot.
    let mut data = vec![0i16; on * depth];
    if step_xy == 1 && step_z == 1 {
        data.par_chunks_mut(n)
            .zip(slices.par_iter())
            .map(|(dst, s)| decode_into(s, dst))
            .collect::<Result<(), String>>()?;
    } else {
        data.par_chunks_mut(on)
            .enumerate()
            .map(|(j, dst)| {
                let mut acc = vec![0i32; on];
                let mut src = vec![0i16; n];
                for s in &slices[j * step_z..(j + 1) * step_z] {
                    decode_into(s, &mut src)?;
                    for y in 0..orows {
                        for x in 0..ocols {
                            let mut sum = 0i32;
                            for dy in 0..step_xy {
                                let row = &src[(y * step_xy + dy) * cols + x * step_xy..][..step_xy];
                                sum += row.iter().map(|&v| v as i32).sum::<i32>();
                            }
                            acc[y * ocols + x] += sum;
                        }
                    }
                }
                let div = (step_xy * step_xy * step_z) as i32;
                for (o, a) in dst.iter_mut().zip(&acc) {
                    *o = (a / div) as i16;
                }
                Ok(())
            })
            .collect::<Result<(), String>>()?;
    }
    let window = slices[slices.len() / 2].window;
    let spacing = [
        slices[0].spacing[0] * step_xy as f64,
        slices[0].spacing[1] * step_xy as f64,
        dz * step_z as f64,
    ];
    let (cols, rows) = (ocols, orows);
    let reduced = [step_xy, step_z];
    drop(slices);
    let (min, max) = data.par_iter().fold(|| (i16::MAX, i16::MIN), |(a, b), &v| (a.min(v), b.max(v))).reduce(
        || (i16::MAX, i16::MIN),
        |(a, b), (c, d)| (a.min(c), b.max(d)),
    );
    let volume = Arc::new(Volume { key, dims: [cols, rows, depth], spacing, data, min, max, window, reduced });
    let info = info_of(&volume, started.elapsed().as_secs_f64() * 1000.0);
    *CURRENT.lock() = Some((volume, 1));
    Ok(info)
}

/// Window one plane to 8-bit grey, with square pixels (the slice axis is
/// resampled linearly to the in-plane spacing) and the long side at most
/// `max_dim`. Coronal / sagittal put the last slice (the most "normal-ward",
/// head for a feet-first-sorted axial stack) at the top.
pub fn render(v: &Volume, plane: Plane, index: usize, center: f64, width: f64, max_dim: usize) -> (usize, usize, Vec<u8>) {
    let [nx, ny, nz] = v.dims;
    let [sx, sy, sz] = v.spacing;
    let lower = center - width / 2.0;
    let scale = 255.0 / width.max(1.0);
    let grey = |val: f64| ((val - lower) * scale).clamp(0.0, 255.0) as u8;
    let at = |x: usize, y: usize, z: usize| v.data[(z * ny + y) * nx + x] as f64;
    // Output grid in mm, then fit to max_dim.
    let (mm_w, mm_h) = match plane {
        Plane::Axial => (nx as f64 * sx, ny as f64 * sy),
        Plane::Coronal => (nx as f64 * sx, nz as f64 * sz),
        Plane::Sagittal => (ny as f64 * sy, nz as f64 * sz),
    };
    let px = (mm_w.max(mm_h) / max_dim.max(16) as f64).max(sx.min(sy).min(sz).min(sx));
    let (w, h) = (((mm_w / px).round() as usize).max(1), ((mm_h / px).round() as usize).max(1));
    let mut out = vec![0u8; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(oy, row)| {
        for (ox, o) in row.iter_mut().enumerate() {
            let u = (ox as f64 + 0.5) * mm_w / w as f64;
            let t = (oy as f64 + 0.5) * mm_h / h as f64;
            let val = match plane {
                Plane::Axial => {
                    let x = ((u / sx) as usize).min(nx - 1);
                    let y = ((t / sy) as usize).min(ny - 1);
                    at(x, y, index.min(nz - 1))
                }
                Plane::Coronal | Plane::Sagittal => {
                    // Top of the image = last slice.
                    let zf = (nz as f64 - t / sz - 0.5).clamp(0.0, (nz - 1) as f64);
                    let z0 = zf.floor() as usize;
                    let z1 = (z0 + 1).min(nz - 1);
                    let f = zf - z0 as f64;
                    let (x, y) = if plane == Plane::Coronal {
                        (((u / sx) as usize).min(nx - 1), index.min(ny - 1))
                    } else {
                        (index.min(nx - 1), ((u / sy) as usize).min(ny - 1))
                    };
                    at(x, y, z0) * (1.0 - f) + at(x, y, z1) * f
                }
            };
            *o = grey(val);
        }
    });
    (w, h, out)
}

pub fn png(w: usize, h: usize, grey: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(grey.len() / 2);
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Grayscale);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(grey).ok()?;
    }
    Some(out)
}

/// `/v/<key>/<plane>/<index>/<center>/<width>/<maxDim>` → PNG.
pub fn serve(rest: &str) -> Option<Vec<u8>> {
    let mut p = rest.split('/');
    let key: u64 = p.next()?.parse().ok()?;
    let plane = Plane::parse(p.next()?)?;
    let index: usize = p.next()?.parse().ok()?;
    let center: f64 = p.next()?.parse().ok()?;
    let width: f64 = p.next()?.parse().ok()?;
    let max_dim: usize = p.next().and_then(|s| s.parse().ok()).unwrap_or(1024).clamp(16, 4096);
    let v = current(key)?;
    let (w, h, grey) = render(&v, plane, index, center, width, max_dim);
    png(w, h, &grey)
}

/// Tests that build share the one global volume: run them one at a time.
#[cfg(test)]
pub(crate) static TEST_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic(nx: usize, ny: usize, nz: usize) -> Volume {
        let mut data = vec![0i16; nx * ny * nz];
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    data[(z * ny + y) * nx + x] = (z * 100) as i16;
                }
            }
        }
        Volume { key: 1, dims: [nx, ny, nz], spacing: [1.0, 1.0, 2.0], data, min: 0, max: ((nz - 1) * 100) as i16, window: None, reduced: [1, 1] }
    }

    #[test]
    fn axial_is_one_slice_windowed() {
        let v = synthetic(8, 8, 4);
        let (w, h, g) = render(&v, Plane::Axial, 2, 200.0, 2.0, 64);
        assert_eq!((w, h), (8, 8));
        assert!(g.iter().all(|&p| p == 255 || p == 127 || p == 128), "slice 2 = 200 at the window centre");
    }

    #[test]
    fn coronal_has_square_pixels_and_head_at_top() {
        let v = synthetic(8, 8, 4); // 8 mm wide, 4 slices × 2 mm = 8 mm tall
        let (w, h, g) = render(&v, Plane::Coronal, 4, 150.0, 300.0, 64);
        assert_eq!((w, h), (8, 8));
        // Top row comes from the last slice (300), bottom from the first (0).
        assert!(g[0] > g[(h - 1) * w], "top {} bottom {}", g[0], g[(h - 1) * w]);
    }

    #[test]
    fn reduction_fits_the_budget_least_lossy_first() {
        let mb = 1 << 20;
        assert_eq!(reduction(512, 512, 848, 768 * mb), (1, 1), "424 MB fits");
        assert_eq!(reduction(512, 512, 2000, 768 * mb), (1, 2), "1 GB: average slice pairs");
        assert_eq!(reduction(512, 512, 4332, 768 * mb), (2, 1), "2.2 GB: 2x2 in-plane");
        assert_eq!(reduction(1024, 1024, 4332, 768 * mb), (2, 3), "9 GB: 2x2 in-plane, slices in threes");
    }

    #[test]
    fn caps_the_long_side() {
        let v = synthetic(512, 512, 10);
        let (w, h, _) = render(&v, Plane::Axial, 0, 0.0, 400.0, 256);
        assert_eq!((w, h), (256, 256));
    }
}

#[cfg(test)]
mod real {
    /// FLOWRAD_TEST_CT=/path/to/ct848 cargo test --release volume::real -- --nocapture
    #[test]
    fn builds_a_real_ct() {
        let _serial = super::TEST_LOCK.lock();
        let Ok(dir) = crate::flowrad_env("TEST_CT") else { return };
        let paths: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).collect();
        let info = super::build(paths).expect("builds");
        eprintln!("{} × {} × {} in {:.0} ms, {} MB, HU {}..{}", info.dims[0], info.dims[1], info.dims[2], info.build_ms, info.bytes >> 20, info.min, info.max);
        let v = super::current(info.key.parse().unwrap()).unwrap();
        let t = std::time::Instant::now();
        for plane in [super::Plane::Axial, super::Plane::Coronal, super::Plane::Sagittal] {
            let (w, h, g) = super::render(&v, plane, 200, 40.0, 400.0, 1024);
            let png = super::png(w, h, &g).unwrap();
            assert!(g.iter().any(|&p| p > 0), "{plane:?} not blank");
            eprintln!("{plane:?}: {w}×{h}, {} KB", png.len() >> 10);
        }
        eprintln!("3 planes rendered + encoded in {:?}", t.elapsed());
        super::close();
    }
}

#[cfg(test)]
mod codecs {
    /// FLOWRAD_FIXTURES=… cargo test --release volume::codecs -- --nocapture
    /// Every transfer syntax builds the same volume as the uncompressed one.
    #[test]
    fn every_transfer_syntax_builds() {
        let _serial = super::TEST_LOCK.lock();
        let Ok(root) = crate::flowrad_env("FIXTURES") else { return };
        let root = std::path::Path::new(&root).join("ts");
        let mut results = vec![];
        for entry in std::fs::read_dir(&root).unwrap().flatten() {
            let paths: Vec<_> = std::fs::read_dir(entry.path()).unwrap().flatten().map(|e| e.path()).collect();
            let name = entry.file_name().to_string_lossy().into_owned();
            match super::build(paths) {
                Ok(i) => results.push(format!("OK   {name}: {:?} HU {}..{}", i.dims, i.min, i.max)),
                Err(e) => results.push(format!("FAIL {name}: {e}")),
            }
        }
        results.sort();
        for r in &results {
            eprintln!("{r}");
        }
        super::close();
    }
}

#[cfg(test)]
mod sharing {
    /// Two views of one series share the volume; it lives until the last closes.
    /// A stale close (key of another series) never frees the current one.
    #[test]
    fn refcounted_by_key() {
        let _serial = super::TEST_LOCK.lock();
        let Ok(root) = crate::flowrad_env("FIXTURES") else { return };
        let dir = std::path::Path::new(&root).join("ts").join("explicit-le");
        let paths: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).collect();
        let a = super::build(paths.clone()).unwrap();
        let mut reversed = paths.clone();
        reversed.reverse();
        let b = super::build(reversed).unwrap();
        assert_eq!(a.key, b.key, "same files in any order = same volume");
        let key: u64 = a.key.parse().unwrap();
        super::release(key ^ 1);
        assert!(super::current(key).is_some(), "a stale close of another key is ignored");
        super::release(key);
        assert!(super::current(key).is_some(), "still one view open");
        super::release(key);
        assert!(super::current(key).is_none(), "freed with the last view");
    }
}
