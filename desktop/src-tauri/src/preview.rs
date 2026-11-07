//! Instant first image: a windowed 8-bit PNG of one uncompressed greyscale
//! slice, rendered in Rust and served at `dicom://…/p/<fileId>`.
//!
//! The renderer shows it the moment a series is hung, while the Cornerstone
//! engine (WebGL context, tools, decode workers) is still starting, then hands
//! over to the real viewport. Compressed or colour files return None and the
//! renderer simply waits for Cornerstone as before.

use std::path::Path;

use dicom_dictionary_std::tags;
use dicom_object::{open_file, DefaultDicomObject};

const UNCOMPRESSED: &[&str] = &["1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.1.99"];

fn num(obj: &DefaultDicomObject, tag: dicom_core::Tag) -> Option<f64> {
    let e = obj.element_opt(tag).ok()??;
    e.to_float64().ok().or_else(|| e.to_str().ok().and_then(|s| s.split('\\').next()?.trim().parse().ok()))
}

fn int(obj: &DefaultDicomObject, tag: dicom_core::Tag) -> Option<i64> {
    obj.element_opt(tag).ok()?.and_then(|e| e.to_int::<i64>().ok())
}

/// The window a series thumbnail is drawn with, in modality units (the same
/// rule as the web viewer, packages/viewer-core seriesThumbnail.ts):
/// the file's own window; else the modality's standard one (CT soft tissue,
/// 40 / 400); else the 1st–99th percentile of the values. Not the min–max
/// range: padding (−2000 / −3024) or one bright artefact stretches it until
/// the anatomy is near-black.
pub fn thumb_window(values: &[f64], file: Option<(f64, f64)>, modality: Option<&str>) -> (f64, f64) {
    if let Some((c, w)) = file {
        if w > 1.0 && c.is_finite() {
            return (c, w);
        }
    }
    if modality.map(|m| m.trim().eq_ignore_ascii_case("CT")).unwrap_or(false) {
        return (40.0, 400.0);
    }
    // A strided subsample of ≤ 64k values keeps this cheap on a 3k² radiograph.
    let step = (values.len() / 65_536).max(1);
    let mut sample: Vec<f64> = values.iter().step_by(step).copied().filter(|v| v.is_finite()).collect();
    if sample.is_empty() {
        return (0.0, 1.0);
    }
    let last = sample.len() - 1;
    let lo_at = (0.01 * last as f64).round() as usize;
    let hi_at = (0.99 * last as f64).round() as usize;
    let lo = *sample.select_nth_unstable_by(lo_at, |a, b| a.total_cmp(b)).1;
    let hi = *sample.select_nth_unstable_by(hi_at, |a, b| a.total_cmp(b)).1;
    if hi <= lo {
        return (lo, 1.0);
    }
    ((lo + hi) / 2.0, hi - lo)
}

fn text(obj: &DefaultDicomObject, tag: dicom_core::Tag) -> Option<String> {
    let e = obj.element_opt(tag).ok()??;
    e.to_str().ok().map(|s| s.trim().trim_end_matches('\0').to_string())
}

/// Encode the first frame as a PNG, or None when this file is not a cheap case.
/// Only the tests use it; the app calls `render_png_sized`.
#[cfg(test)]
pub fn render_png(path: &Path) -> Option<Vec<u8>> {
    render_png_sized(path, None)
}

/// Box-downsample `gray` (rows × cols) so the long side is at most `max_dim`.
pub fn downsample(gray: &[u8], rows: usize, cols: usize, max_dim: usize) -> (Vec<u8>, usize, usize) {
    let step = rows.max(cols).div_ceil(max_dim.max(1)).max(1);
    if step == 1 {
        return (gray.to_vec(), rows, cols);
    }
    let (r2, c2) = (rows / step, cols / step);
    let mut out = Vec::with_capacity(r2 * c2);
    for y in 0..r2 {
        for x in 0..c2 {
            let mut sum = 0u32;
            for dy in 0..step {
                let row = &gray[(y * step + dy) * cols + x * step..][..step];
                sum += row.iter().map(|&v| v as u32).sum::<u32>();
            }
            out.push((sum / (step * step) as u32) as u8);
        }
    }
    (out, r2, c2)
}

/// As render_png, with the long side capped at `max_dim` (series thumbnails:
/// a few KB instead of a decoded full-size slice in the renderer).
pub fn render_png_sized(path: &Path, max_dim: Option<usize>) -> Option<Vec<u8>> {
    let obj = open_file(path).ok()?;
    let ts = obj.meta().transfer_syntax().trim_end_matches('\0').to_string();
    if int(&obj, tags::SAMPLES_PER_PIXEL).unwrap_or(1) != 1 {
        return None;
    }
    let invert = text(&obj, tags::PHOTOMETRIC_INTERPRETATION).as_deref() == Some("MONOCHROME1");
    let modality = text(&obj, tags::MODALITY);
    if !UNCOMPRESSED.contains(&ts.as_str()) {
        // Compressed greyscale: series THUMBNAILS still come from Rust (the
        // native image core decodes every transfer syntax), so a compressed
        // study never starts the JS engine just to draw its series cards.
        // The full-size first-image preview stays uncompressed-only.
        return max_dim.and_then(|m| render_decoded_thumbnail(path, m, invert, modality.as_deref()));
    }
    let rows = int(&obj, tags::ROWS)? as usize;
    let cols = int(&obj, tags::COLUMNS)? as usize;
    let bits = int(&obj, tags::BITS_ALLOCATED)?;
    let signed = int(&obj, tags::PIXEL_REPRESENTATION) == Some(1);
    let slope = num(&obj, tags::RESCALE_SLOPE).unwrap_or(1.0);
    let intercept = num(&obj, tags::RESCALE_INTERCEPT).unwrap_or(0.0);
    let bytes = obj.element(tags::PIXEL_DATA).ok()?.to_bytes().ok()?;
    let n = rows * cols;
    let values: Vec<f64> = match bits {
        16 if bytes.len() >= n * 2 => bytes[..n * 2]
            .chunks_exact(2)
            .map(|c| {
                let raw = if signed { i16::from_le_bytes([c[0], c[1]]) as f64 } else { u16::from_le_bytes([c[0], c[1]]) as f64 };
                raw * slope + intercept
            })
            .collect(),
        8 if bytes.len() >= n => bytes[..n].iter().map(|&b| b as f64 * slope + intercept).collect(),
        _ => return None,
    };
    let file_window = match (num(&obj, tags::WINDOW_CENTER), num(&obj, tags::WINDOW_WIDTH)) {
        (Some(c), Some(w)) => Some((c, w)),
        _ => None,
    };
    let (center, width) = thumb_window(&values, file_window, modality.as_deref());
    let lower = center - width / 2.0;
    let gray: Vec<u8> = values
        .iter()
        .map(|&v| {
            let g = (((v - lower) / width) * 255.0).clamp(0.0, 255.0) as u8;
            if invert { 255 - g } else { g }
        })
        .collect();
    let (gray, rows, cols) = match max_dim {
        Some(m) => downsample(&gray, rows, cols, m),
        None => (gray, rows, cols),
    };
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, cols as u32, rows as u32);
        enc.set_color(png::ColorType::Grayscale);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(&gray).ok()?;
    }
    Some(out)
}

/// A thumbnail through the native image core (any transfer syntax), at the
/// file's window as the native viewport opens it.
fn render_decoded_thumbnail(path: &Path, max_dim: usize, invert: bool, modality: Option<&str>) -> Option<Vec<u8>> {
    let slice = crate::image_store::decode_slice(path).ok()?;
    let (rows, cols) = (slice.rows, slice.cols);
    if rows == 0 || cols == 0 || slice.data.len() < rows * cols {
        return None;
    }
    let values: Vec<f64> = slice.data[..rows * cols].iter().map(|&v| v as f64).collect();
    let (center, width) = thumb_window(&values, slice.window, modality);
    let lower = center - width / 2.0;
    let gray: Vec<u8> = values
        .iter()
        .map(|&v| {
            let g = (((v - lower) / width) * 255.0).clamp(0.0, 255.0) as u8;
            // MONOCHROME1 (CR / DX): low values are white.
            if invert { 255 - g } else { g }
        })
        .collect();
    let (gray, rows, cols) = downsample(&gray, rows, cols, max_dim);
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, cols as u32, rows as u32);
        enc.set_color(png::ColorType::Grayscale);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(&gray).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn thumb_window_prefers_the_file_then_ct_soft_tissue_then_percentiles() {
        use super::thumb_window;
        let flat: Vec<f64> = vec![0.0; 10];
        assert_eq!(thumb_window(&flat, Some((-600.0, 1500.0)), Some("CT")), (-600.0, 1500.0));
        assert_eq!(thumb_window(&[-3024.0, 3000.0], None, Some(" ct ")), (40.0, 400.0));
        // Anatomy 100..=300 plus 1 % padding at -2000 and 0.5 % artefact at 30 000.
        let mut v: Vec<f64> = (0..10_000).map(|i| 100.0 + (i % 201) as f64).collect();
        for x in v.iter_mut().take(100) {
            *x = -2000.0;
        }
        for x in v.iter_mut().skip(100).take(50) {
            *x = 30_000.0;
        }
        let (c, w) = thumb_window(&v, None, Some("MR"));
        assert!(c > 100.0 && c < 300.0, "centre {c}");
        assert!(w < 2500.0, "width {w}");
        assert_eq!(thumb_window(&[5.0, 5.0], None, None), (5.0, 1.0));
        assert_eq!(thumb_window(&[], None, None), (0.0, 1.0));
    }

    #[test]
    fn downsample_box_averages_to_the_cap() {
        let gray: Vec<u8> = (0..16).map(|i| (i * 10) as u8).collect(); // 4×4
        let (out, r, c) = super::downsample(&gray, 4, 4, 2);
        assert_eq!((r, c), (2, 2));
        assert_eq!(out[0], ((0 + 10 + 40 + 50) / 4) as u8);
        let (same, r, c) = super::downsample(&gray, 4, 4, 8);
        assert_eq!((r, c, same.len()), (4, 4, 16));
    }

    /// FLOWRAD_FIXTURES=/tmp/fixtures cargo test preview
    #[test]
    fn renders_uncompressed_and_skips_compressed() {
        let Ok(root) = crate::flowrad_env("FIXTURES") else { return };
        let root = std::path::Path::new(&root);
        let first = |dir: &str| {
            let mut v: Vec<_> = std::fs::read_dir(root.join(dir)).unwrap().flatten().map(|e| e.path()).collect();
            v.sort();
            v.remove(0)
        };
        let t = std::time::Instant::now();
        let png = super::render_png(&first("ts/explicit-le")).expect("explicit LE renders");
        eprintln!("preview in {:?}, {} bytes", t.elapsed(), png.len());
        assert_eq!(&png[1..4], b"PNG");
        assert!(super::render_png(&first("ts/j2k-lossless")).is_none());
    }
}
