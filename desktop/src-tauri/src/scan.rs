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
    /// Structured reports and key-image notes found alongside the images.
    pub documents: Vec<crate::documents::Document>,
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
    cache_dir
        .join("scan")
        .join(format!("{}.json", stable_hash(key)))
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
    let file = CacheFile {
        version: CACHE_VERSION,
        entries,
    };
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

/// Header reads are I/O-latency bound (open, antivirus callback, first 64 KB),
/// not CPU bound, so the scan runs on its own pool with twice the cores:
/// while half the threads wait on the disk the other half parse.
fn scan_pool() -> &'static rayon::ThreadPool {
    static POOL: std::sync::OnceLock<rayon::ThreadPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        rayon::ThreadPoolBuilder::new()
            .num_threads((cores * 2).clamp(8, 32))
            .thread_name(|i| format!("scan-{i}"))
            .build()
            .expect("scan thread pool")
    })
}

/// `dir` when it holds exactly one folder and nothing else (dotfiles aside).
fn single_child_dir(dir: &Path) -> Option<PathBuf> {
    let entries: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            !p.file_name()
                .map(|n| n.to_string_lossy().starts_with('.'))
                .unwrap_or(true)
        })
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
    on_progress(ScanProgress {
        phase: "listing",
        read: 0,
        accepted: 0,
        total: 0,
    });
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
    let documents: Mutex<Vec<crate::documents::Document>> = Mutex::new(Vec::new());
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

    // Test hook (e2e "MPR while a cold scan is still streaming"): slow each
    // file down so a small study streams for seconds, like a cold 4,000-file disc.
    let throttle = crate::flowrad_env("SCAN_DELAY_US")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(std::time::Duration::from_micros);
    let mut headers: Vec<(Header, bool)> = scan_pool().install(|| {
        files
            .par_iter()
            .filter_map(|path| {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                if let Some(d) = throttle {
                    std::thread::sleep(d);
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
                    _ => {
                        let header = read_header(path);
                        // Not an image: maybe a structured report or key-image note.
                        if header.is_none() && crate::header::is_sr_candidate(path) {
                            if let Some(doc) = crate::documents::read_document(path) {
                                documents.lock().push(doc);
                            }
                        }
                        header.map(|h| (h, false))
                    }
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
                    on_progress(ScanProgress {
                        phase: "reading",
                        read: n,
                        accepted: a,
                        total,
                    });
                }
                result
            })
            .collect()
    });

    flush(true);
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }

    // Patient identifiers for cache hits: one fresh header read per study.
    let mut fresh_by_study: HashMap<String, Header> = HashMap::new();
    for (h, from_cache) in &headers {
        if !from_cache {
            if let Some(uid) = &h.study_instance_uid {
                fresh_by_study
                    .entry(uid.clone())
                    .or_insert_with(|| h.clone());
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
            if let Some(src) = h
                .study_instance_uid
                .as_ref()
                .and_then(|u| fresh_by_study.get(u))
            {
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
        documents: documents.into_inner(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_hash_is_deterministic_and_distinct() {
        assert_eq!(stable_hash("/media/cd"), stable_hash("/media/cd"));
        assert_ne!(stable_hash("/media/cd"), stable_hash("/media/cd2"));
        assert_eq!(stable_hash("x").len(), 16);
    }

    #[test]
    fn single_child_dir_descends_only_through_a_lone_folder() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("cd-media")).unwrap();
        fs::write(d.path().join(".hidden"), b"x").unwrap();
        assert_eq!(single_child_dir(d.path()), Some(d.path().join("cd-media")));
        fs::write(d.path().join("README.TXT"), b"x").unwrap();
        assert_eq!(single_child_dir(d.path()), None);
    }

    /// FLOWRAD_FIXTURES=/tmp/fixtures cargo test scan
    #[test]
    fn scans_a_disc_via_dicomdir_then_hits_the_cache_without_storing_phi() {
        let Ok(root) = crate::flowrad_env("FIXTURES") else {
            return;
        };
        let cache = tempfile::tempdir().unwrap();
        let paths = vec![Path::new(&root).join("cd-media")];
        let cancel = AtomicBool::new(false);
        let batches = AtomicUsize::new(0);
        let run = || {
            scan(&paths, cache.path(), &cancel, &|_| {}, &|_| {}, &|b| {
                batches.fetch_add(b.len(), Ordering::Relaxed);
            })
            .unwrap()
        };
        let first = run();
        assert!(first.used_dicomdir);
        assert_eq!(first.headers.len(), 84);
        assert_eq!(first.cache_hits, 0);
        assert_eq!(
            batches.load(Ordering::Relaxed),
            84,
            "every header streamed in a batch"
        );
        assert!(
            first.headers.iter().all(|h| h.patient_name.is_some()),
            "overlay still gets patient names"
        );

        let second = run();
        assert_eq!(second.cache_hits, 84);
        assert!(
            second.headers.iter().all(|h| h.patient_name.is_some()),
            "names re-read, not cached"
        );

        // The on-disk cache holds no patient identifiers.
        let cached: String = walkdir::WalkDir::new(cache.path().join("scan"))
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .map(|e| fs::read_to_string(e.path()).unwrap())
            .collect();
        assert!(!cached.is_empty());
        for phi in ["PHANTOM^CT", "PHANTOM^MR", "FIX-001", "FIX-002"] {
            assert!(!cached.contains(phi), "{phi} in the scan cache");
        }
    }

    #[test]
    fn a_cancelled_scan_reports_cancelled() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("IM1"), b"x").unwrap();
        let cancel = AtomicBool::new(true);
        let err = scan(
            &[d.path().to_path_buf()],
            d.path(),
            &cancel,
            &|_| {},
            &|_| {},
            &|_| {},
        )
        .unwrap_err();
        assert_eq!(err, "cancelled");
    }
}
