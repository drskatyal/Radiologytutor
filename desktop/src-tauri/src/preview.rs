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

/// Encode the first frame as a PNG, or None when this file is not a cheap case.
pub fn render_png(path: &Path) -> Option<Vec<u8>> {
    let obj = open_file(path).ok()?;
    let ts = obj.meta().transfer_syntax().trim_end_matches('\0').to_string();
    if !UNCOMPRESSED.contains(&ts.as_str()) || int(&obj, tags::SAMPLES_PER_PIXEL).unwrap_or(1) != 1 {
        return None;
    }
    let rows = int(&obj, tags::ROWS)? as usize;
    let cols = int(&obj, tags::COLUMNS)? as usize;
    let bits = int(&obj, tags::BITS_ALLOCATED)?;
    let signed = int(&obj, tags::PIXEL_REPRESENTATION) == Some(1);
    let slope = num(&obj, tags::RESCALE_SLOPE).unwrap_or(1.0);
    let intercept = num(&obj, tags::RESCALE_INTERCEPT).unwrap_or(0.0);
    let invert = obj
        .element_opt(tags::PHOTOMETRIC_INTERPRETATION)
        .ok()
        .flatten()
        .and_then(|e| e.to_str().ok().map(|s| s.trim().trim_end_matches('\0') == "MONOCHROME1"))
        .unwrap_or(false);
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
    // The file's own window, as the viewer opens with it; else the data range.
    let (center, width) = match (num(&obj, tags::WINDOW_CENTER), num(&obj, tags::WINDOW_WIDTH)) {
        (Some(c), Some(w)) if w > 1.0 => (c, w),
        _ => {
            let (lo, hi) = values.iter().fold((f64::MAX, f64::MIN), |(a, b), &v| (a.min(v), b.max(v)));
            ((lo + hi) / 2.0, (hi - lo).max(1.0))
        }
    };
    let lower = center - width / 2.0;
    let gray: Vec<u8> = values
        .iter()
        .map(|&v| {
            let g = (((v - lower) / width) * 255.0).clamp(0.0, 255.0) as u8;
            if invert { 255 - g } else { g }
        })
        .collect();
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
