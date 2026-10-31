//! Turning a selection into headers, fast.
//!
//! The web viewer reads headers one file at a time on the main thread. Here
//! the work fans out across every core (rayon), each file is parsed only up to
//! its pixel data, and the result of a scan is cached on disk keyed by
//! (path, size, mtime) so re-opening a study skips parsing entirely. The cache
//! holds identity and geometry only — patient identifiers are re-read from one
//! file per study on every open and are never persisted.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use parking_lot::Mutex;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::header::{mtime_secs, read_header, Header};
use crate::sources::{
    dicomdir_files, extract_zip, find_dicomdir, is_dicomdir_name, is_zip, walk_folder, SourceKind,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub phase: &'static str,
    pub read: usize,
    pub accepted: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanTimings {
    pub list_ms: f64,
    pub parse_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub headers: Vec<Header>,
    pub kind: SourceKind,
    /// Display label for the history list: folder / archive / disc name.
    pub label: String,
    pub inspected: usize,
    pub skipped: usize,
    pub cache_hits: usize,
    pub used_dicomdir: bool,
    pub warnings: Vec<String>,
    pub timings: ScanTimings,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    entries: HashMap<String, Header>,
}

const CACHE_VERSION: u32 = 3;

pub fn stable_hash(value: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn cache_path(cache_dir: &Path, key: &str) -> PathBuf {
    cache_dir.join("scan").join(format!("{}.json", stable_hash(key)))
}

fn load_cache(path: &Path) -> HashMap<String, Header> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CacheFile>(&bytes).ok())
        .filter(|c| c.version == CACHE_VERSION)
        .map(|c| c.entries)
        .unwrap_or_default()
}

fn save_cache(path: &Path, headers: &[Header]) {
    let entries = headers
        .iter()
        .map(|h| (h.file_name.clone(), h.without_phi()))
        .collect();
    let file = CacheFile { version: CACHE_VERSION, entries };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(bytes) = serde_json::to_vec(&file) {
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(tmp, path);
        }
    }
}

/// `dir` when it holds exactly one folder and nothing else (dotfiles aside).
fn single_child_dir(dir: &Path) -> Option<PathBuf> {
    let entries: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| !p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(true))
        .collect();
    match entries.as_slice() {
        [only] if only.is_dir() => Some(only.clone()),
        _ => None,
    }
}

fn label_for(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Expand the selection into candidate files. Returns the files, the kind of
/// source, whether a DICOMDIR drove the listing, and any warnings.
fn list_candidates(
    paths: &[PathBuf],
    cache_dir: &Path,
    warnings: &mut Vec<String>,
) -> (Vec<PathBuf>, SourceKind, bool) {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut kind = SourceKind::Files;
    let mut used_dicomdir = false;

    let expand_dir = |dir: &Path, out: &mut Vec<PathBuf>, warnings: &mut Vec<String>| -> bool {
        if let Some(index) = find_dicomdir(dir) {
            match dicomdir_files(&index) {
                Ok((found, missing)) if !found.is_empty() && missing == 0 => {
                    out.extend(found);
                    return true;
                }
                Ok((found, missing)) if !found.is_empty() => {
                    warnings.push(format!(
                        "The DICOMDIR index lists {missing} file(s) that are not on this media; the whole folder was scanned instead."
                    ));
                }
                Ok(_) => {}
                Err(e) => warnings.push(e),
            }
        }
        out.extend(walk_folder(dir));
        false
    };

    for path in paths {
        if path.is_dir() {
            if paths.len() == 1 {
                kind = SourceKind::Folder;
            }
            used_dicomdir |= expand_dir(path, &mut out, warnings);
        } else if path.is_file() && is_dicomdir_name(path) {
            kind = SourceKind::Dicomdir;
            match dicomdir_files(path) {
                Ok((found, missing)) => {
                    if missing > 0 {
                        warnings.push(format!(
                            "{missing} file(s) referenced by the DICOMDIR are missing."
                        ));
                    }
                    if found.is_empty() {
                        if let Some(parent) = path.parent() {
                            out.extend(walk_folder(parent));
                        }
                    } else {
                        used_dicomdir = true;
                        out.extend(found);
                    }
                }
                Err(e) => {
                    warnings.push(e);
                    if let Some(parent) = path.parent() {
                        out.extend(walk_folder(parent));
                    }
                }
            }
        } else if path.is_file() && is_zip(path) {
            kind = SourceKind::Zip;
            let meta = fs::metadata(path).ok();
            let key = format!(
                "{}|{}|{}",
                path.display(),
                meta.as_ref().map(|m| m.len()).unwrap_or(0),
                meta.as_ref().map(mtime_secs).unwrap_or(0)
            );
            let dest = cache_dir.join("archives").join(stable_hash(&key));
            match extract_zip(path, &dest) {
                Ok(dir) => {
                    // Archives usually wrap the disc in one top-level folder.
                    let dir = single_child_dir(&dir).unwrap_or(dir);
                    used_dicomdir |= expand_dir(&dir, &mut out, warnings);
                }
                Err(e) => warnings.push(e),
            }
        } else if path.is_file() {
            out.push(path.clone());
        } else {
            warnings.push(format!("{} could not be found.", path.display()));
        }
    }
    let mut seen = HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    (out, kind, used_dicomdir)
}

pub fn scan(
    paths: &[PathBuf],
    cache_dir: &Path,
    cancel: &AtomicBool,
    on_progress: &(dyn Fn(ScanProgress) + Sync),
    on_header: &(dyn Fn(&mut Header) + Sync),
    on_batch: &(dyn Fn(Vec<Header>) + Sync),
) -> Result<ScanResult, String> {
    let started = Instant::now();
    let mut warnings = Vec::new();
    on_progress(ScanProgress { phase: "listing", read: 0, accepted: 0, total: 0 });
    let (files, kind, used_dicomdir) = list_candidates(paths, cache_dir, &mut warnings);
    let list_ms = started.elapsed().as_secs_f64() * 1000.0;

    let cache_key = paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("|");
    let cache_file = cache_path(cache_dir, &cache_key);
    let cached = load_cache(&cache_file);

    let total = files.len();
    let read = AtomicUsize::new(0);
    let accepted = AtomicUsize::new(0);
    let hits = AtomicUsize::new(0);
    let parse_started = Instant::now();
    // Progressive open: headers stream to the renderer in small batches so the
    // first series is on screen while a 2000-file disc is still being read.
    let pending: Mutex<(Vec<Header>, Instant)> = Mutex::new((Vec::new(), Instant::now()));
    // The very first image flushes alone: it is what puts pixels on screen.
    let first_sent = AtomicBool::new(false);
    let flush = |force: bool| {
        let mut guard = pending.lock();
        let first = !guard.0.is_empty() && !first_sent.swap(true, Ordering::Relaxed);
        let due = !guard.0.is_empty()
            && (force || first || guard.0.len() >= 256 || guard.1.elapsed().as_millis() >= 60);
        if due {
            let batch = std::mem::take(&mut guard.0);
            guard.1 = Instant::now();
            drop(guard);
            on_batch(batch);
        }
    };

    let mut headers: Vec<(Header, bool)> = files
        .par_iter()
        .filter_map(|path| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let key = path.to_string_lossy();
            let meta = fs::metadata(path).ok();
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = meta.as_ref().map(mtime_secs).unwrap_or(0);
            let result = match cached.get(key.as_ref()) {
                Some(hit) if hit.size_bytes == size && hit.mtime == mtime => {
                    hits.fetch_add(1, Ordering::Relaxed);
                    Some((hit.clone(), true))
                }
                _ => read_header(path).map(|h| (h, false)),
            };
            let result = result.map(|(mut h, hit)| {
                on_header(&mut h);
                pending.lock().0.push(h.clone());
                flush(false);
                (h, hit)
            });
            let n = read.fetch_add(1, Ordering::Relaxed) + 1;
            let a = if result.is_some() {
                accepted.fetch_add(1, Ordering::Relaxed) + 1
            } else {
                accepted.load(Ordering::Relaxed)
            };
            if n % 64 == 0 || n == total {
                on_progress(ScanProgress { phase: "reading", read: n, accepted: a, total });
            }
            result
        })
        .collect();

    flush(true);
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }

    // Patient identifiers for cache hits: one fresh header read per study.
    let mut fresh_by_study: HashMap<String, Header> = HashMap::new();
    for (h, from_cache) in &headers {
        if !from_cache {
            if let Some(uid) = &h.study_instance_uid {
                fresh_by_study.entry(uid.clone()).or_insert_with(|| h.clone());
            }
        }
    }
    let mut need: Vec<(String, String)> = Vec::new();
    for (h, from_cache) in &headers {
        if *from_cache {
            if let Some(uid) = &h.study_instance_uid {
                if !fresh_by_study.contains_key(uid) && !need.iter().any(|(u, _)| u == uid) {
                    need.push((uid.clone(), h.file_name.clone()));
                }
            }
        }
    }
    for (uid, file) in need {
        if let Some(fresh) = read_header(Path::new(&file)) {
            fresh_by_study.insert(uid, fresh);
        }
    }
    for (h, from_cache) in headers.iter_mut() {
        if *from_cache {
            if let Some(src) = h.study_instance_uid.as_ref().and_then(|u| fresh_by_study.get(u)) {
                h.copy_patient_fields_from(src);
            }
        }
    }

    let parse_ms = parse_started.elapsed().as_secs_f64() * 1000.0;
    let mut headers: Vec<Header> = headers.into_iter().map(|(h, _)| h).collect();
    headers.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    save_cache(&cache_file, &headers);

    let label = paths.first().map(|p| label_for(p)).unwrap_or_default();
    Ok(ScanResult {
        skipped: total.saturating_sub(headers.len()),
        inspected: total,
        cache_hits: hits.load(Ordering::Relaxed),
        headers,
        kind,
        label,
        used_dicomdir,
        warnings,
        timings: ScanTimings {
            list_ms,
            parse_ms,
            total_ms: started.elapsed().as_secs_f64() * 1000.0,
        },
    })
}

