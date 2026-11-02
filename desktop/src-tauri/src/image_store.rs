//! Phase 2, P2.1 (docs/NATIVE_RENDERER.md): the native image core.
//!
//! Decoded slices live HERE, once per process, shared by every window: no
//! copy in a JS heap, no second copy as a WebGL texture in WebView2's GPU
//! process. A slice is stored as modality values (rescale applied: HU for CT)
//! in i16, ready to upload as an R16Sint texture with window/level done in the
//! shader.
//!
//! The cache has a hard byte budget (FLOWRAD_NATIVE_CACHE_MB, default 64) and
//! evicts least-recently-used slices. Prefetch decodes around the current
//! slice on the rayon pool; a newer prefetch request supersedes an older one
//! (scrolling the other way drops the queued work for the old direction).
//!
//! Decoding reuses volume.rs: uncompressed little-endian 8/16-bit pixels come
//! straight from a memory map; everything else (JPEG, JPEG 2000, RLE) goes
//! through dicom-pixeldata. Colour is not handled here yet: those series stay
//! on the JS path (P2.1 falls back per series, never a blank viewport).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use dicom_dictionary_std::tags;
use dicom_object::OpenFileOptions;
use parking_lot::Mutex;
use serde::Serialize;

use crate::volume::{decode_into, int, num, SliceHeader};

/// One decoded frame.
pub struct Slice {
    pub rows: usize,
    pub cols: usize,
    /// Modality values (rescale slope / intercept applied), row-major.
    pub data: Vec<i16>,
    /// The file's own window (centre, width), in modality units.
    pub window: Option<(f64, f64)>,
    /// Row, column spacing in mm.
    pub spacing: [f64; 2],
}

impl Slice {
    pub fn bytes(&self) -> usize {
        self.data.len() * 2
    }
}

#[derive(Serialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoreStats {
    pub budget_mb: f64,
    pub used_mb: f64,
    pub slices: usize,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub decode_ms_total: f64,
    pub decode_ms_max: f64,
}

struct Entry {
    slice: Arc<Slice>,
    last_use: u64,
}

pub struct ImageStore {
    budget: usize,
    inner: Mutex<Inner>,
    /// Bumped by every prefetch request; queued work from an older one is dropped.
    generation: AtomicU64,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<PathBuf, Entry>,
    used: usize,
    clock: u64,
    stats: StoreStats,
}

pub fn budget_from_env() -> usize {
    let mb = crate::flowrad_env("NATIVE_CACHE_MB").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(64);
    mb.clamp(8, 4096) * 1_048_576
}

impl ImageStore {
    pub fn new(budget: usize) -> Self {
        Self { budget, inner: Mutex::new(Inner::default()), generation: AtomicU64::new(0) }
    }

    /// Cached slice, or None (no decode).
    pub fn peek(&self, path: &Path) -> Option<Arc<Slice>> {
        let mut g = self.inner.lock();
        g.clock += 1;
        let clock = g.clock;
        let hit = g.entries.get_mut(path).map(|e| {
            e.last_use = clock;
            e.slice.clone()
        });
        if hit.is_some() {
            g.stats.hits += 1;
        }
        hit
    }

    /// The slice, decoding it on a miss (on the caller's thread).
    pub fn get(&self, path: &Path) -> Result<Arc<Slice>, String> {
        if let Some(s) = self.peek(path) {
            return Ok(s);
        }
        let started = Instant::now();
        let slice = Arc::new(decode_slice(path)?);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        self.insert(path, slice.clone(), ms);
        Ok(slice)
    }

    fn insert(&self, path: &Path, slice: Arc<Slice>, decode_ms: f64) {
        let mut g = self.inner.lock();
        g.stats.misses += 1;
        g.stats.decode_ms_total += decode_ms;
        g.stats.decode_ms_max = g.stats.decode_ms_max.max(decode_ms);
        g.clock += 1;
        let clock = g.clock;
        let bytes = slice.bytes();
        if let Some(old) = g.entries.insert(path.to_path_buf(), Entry { slice, last_use: clock }) {
            g.used -= old.slice.bytes();
        }
        g.used += bytes;
        self.evict(&mut g, path);
    }

    /// Drop least-recently-used slices until under budget, never `keep` (just inserted).
    fn evict(&self, g: &mut Inner, keep: &Path) {
        while g.used > self.budget && g.entries.len() > 1 {
            let victim = g
                .entries
                .iter()
                .filter(|(p, _)| p.as_path() != keep)
                .min_by_key(|(_, e)| e.last_use)
                .map(|(p, _)| p.clone());
            let Some(victim) = victim else { break };
            if let Some(e) = g.entries.remove(&victim) {
                g.used -= e.slice.bytes();
                g.stats.evictions += 1;
            }
        }
    }

    /// Decode `paths` (nearest first) in the background, within the budget.
    /// A later call supersedes this one: its unstarted work is dropped.
    pub fn prefetch(self: &Arc<Self>, paths: Vec<PathBuf>) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        // Never prefetch more than the budget can hold (assume the first slice's size).
        let store = self.clone();
        rayon::spawn(move || {
            let mut planned = 0usize;
            for path in paths {
                if store.generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                if let Some(s) = store.peek(&path) {
                    planned += s.bytes();
                } else if let Ok(s) = store.get(&path) {
                    planned += s.bytes();
                }
                if planned >= store.budget / 2 {
                    return;
                }
            }
        });
    }

    /// Free everything (study closed): back to baseline.
    pub fn clear(&self) {
        let mut g = self.inner.lock();
        g.entries.clear();
        g.entries.shrink_to_fit();
        g.used = 0;
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn stats(&self) -> StoreStats {
        let g = self.inner.lock();
        StoreStats {
            budget_mb: self.budget as f64 / 1_048_576.0,
            used_mb: g.used as f64 / 1_048_576.0,
            slices: g.entries.len(),
            ..g.stats.clone()
        }
    }
}

/// Header for a 2D slice (no geometry required, unlike a volume slice).
fn read_slice_header(path: &Path) -> Result<SliceHeader, String> {
    let head = OpenFileOptions::new()
        .read_until(tags::PIXEL_DATA)
        .open_file(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if int(&head, tags::SAMPLES_PER_PIXEL).unwrap_or(1) != 1 {
        return Err("colour: not on the native path yet".into());
    }
    Ok(SliceHeader {
        path: path.to_path_buf(),
        position: [0.0; 3],
        rows: int(&head, tags::ROWS).ok_or("no Rows")? as usize,
        cols: int(&head, tags::COLUMNS).ok_or("no Columns")? as usize,
        spacing: [num(&head, tags::PIXEL_SPACING, 0).unwrap_or(1.0), num(&head, tags::PIXEL_SPACING, 1).unwrap_or(1.0)],
        orientation: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
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

pub fn decode_slice(path: &Path) -> Result<Slice, String> {
    let h = read_slice_header(path)?;
    let mut data = vec![0i16; h.rows * h.cols];
    decode_into(&h, &mut data)?;
    Ok(Slice { rows: h.rows, cols: h.cols, data, window: h.window, spacing: h.spacing })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dicom_core::{DataElement, PrimitiveValue, VR};
    use dicom_object::{FileMetaTableBuilder, InMemDicomObject};

    /// A tiny uncompressed CT slice: unsigned 16-bit stored values, slope 1,
    /// intercept -1024, window 40/400.
    fn write_ct(dir: &Path, name: &str, rows: u16, cols: u16, value: u16) -> PathBuf {
        let mut obj = InMemDicomObject::new_empty();
        let put = |obj: &mut InMemDicomObject, tag, vr, v: PrimitiveValue| obj.put(DataElement::new(tag, vr, v));
        put(&mut obj, tags::SOP_CLASS_UID, VR::UI, PrimitiveValue::from("1.2.840.10008.5.1.4.1.1.2"));
        put(&mut obj, tags::SOP_INSTANCE_UID, VR::UI, PrimitiveValue::from(format!("1.2.3.{value}")));
        put(&mut obj, tags::SAMPLES_PER_PIXEL, VR::US, PrimitiveValue::from(1u16));
        put(&mut obj, tags::PHOTOMETRIC_INTERPRETATION, VR::CS, PrimitiveValue::from("MONOCHROME2"));
        put(&mut obj, tags::ROWS, VR::US, PrimitiveValue::from(rows));
        put(&mut obj, tags::COLUMNS, VR::US, PrimitiveValue::from(cols));
        put(&mut obj, tags::BITS_ALLOCATED, VR::US, PrimitiveValue::from(16u16));
        put(&mut obj, tags::BITS_STORED, VR::US, PrimitiveValue::from(12u16));
        put(&mut obj, tags::HIGH_BIT, VR::US, PrimitiveValue::from(11u16));
        put(&mut obj, tags::PIXEL_REPRESENTATION, VR::US, PrimitiveValue::from(0u16));
        put(&mut obj, tags::RESCALE_INTERCEPT, VR::DS, PrimitiveValue::from("-1024"));
        put(&mut obj, tags::RESCALE_SLOPE, VR::DS, PrimitiveValue::from("1"));
        put(&mut obj, tags::WINDOW_CENTER, VR::DS, PrimitiveValue::from("40"));
        put(&mut obj, tags::WINDOW_WIDTH, VR::DS, PrimitiveValue::from("400"));
        let px: Vec<u8> = (0..rows as usize * cols as usize).flat_map(|i| (value + i as u16).to_le_bytes()).collect();
        put(&mut obj, tags::PIXEL_DATA, VR::OW, PrimitiveValue::from(px));
        let file = obj
            .with_meta(
                FileMetaTableBuilder::new()
                    .transfer_syntax("1.2.840.10008.1.2.1")
                    .media_storage_sop_class_uid("1.2.840.10008.5.1.4.1.1.2")
                    .media_storage_sop_instance_uid(format!("1.2.3.{value}")),
            )
            .unwrap();
        let path = dir.join(name);
        file.write_to_file(&path).unwrap();
        path
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("flowrad-store-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn decodes_to_modality_values() {
        let d = tmp("decode");
        let p = write_ct(&d, "a.dcm", 4, 4, 1000);
        let s = decode_slice(&p).unwrap();
        assert_eq!((s.rows, s.cols), (4, 4));
        assert_eq!(s.data[0], 1000 - 1024);
        assert_eq!(s.data[15], 1015 - 1024);
        assert_eq!(s.window, Some((40.0, 400.0)));
    }

    #[test]
    fn evicts_least_recently_used_within_budget() {
        let d = tmp("lru");
        let a = write_ct(&d, "a.dcm", 32, 32, 1); // 2 KB each
        let b = write_ct(&d, "b.dcm", 32, 32, 2);
        let c = write_ct(&d, "c.dcm", 32, 32, 3);
        let store = ImageStore::new(2 * 32 * 32 * 2); // room for two
        store.get(&a).unwrap();
        store.get(&b).unwrap();
        store.get(&a).unwrap(); // a is now more recent than b
        store.get(&c).unwrap(); // evicts b
        assert!(store.peek(&a).is_some());
        assert!(store.peek(&b).is_none());
        assert!(store.peek(&c).is_some());
        let st = store.stats();
        assert_eq!(st.slices, 2);
        assert_eq!(st.evictions, 1);
        assert!(st.used_mb * 1_048_576.0 <= (2 * 32 * 32 * 2) as f64);
        store.clear();
        assert_eq!(store.stats().slices, 0);
        assert_eq!(store.stats().used_mb, 0.0);
    }

    #[test]
    fn prefetch_fills_the_cache_in_the_background() {
        let d = tmp("prefetch");
        let paths: Vec<PathBuf> = (0..6).map(|i| write_ct(&d, &format!("{i}.dcm"), 16, 16, i as u16)).collect();
        let store = Arc::new(ImageStore::new(1 << 20));
        store.prefetch(paths.clone());
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        while store.stats().slices < 6 && Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(store.stats().slices, 6);
    }
}
