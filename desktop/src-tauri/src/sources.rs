//! Where files come from: folders, DICOMDIR indexes, zip archives and
//! optical/removable media. Everything here turns a user's selection into a
//! flat list of candidate file paths; `scan.rs` decides which are images.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use dicom_dictionary_std::tags;
use dicom_object::OpenFileOptions;
use serde::Serialize;
use walkdir::WalkDir;

use crate::header::is_obviously_not_dicom;

/// What one user-selected path turned out to be.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Folder,
    Dicomdir,
    Zip,
    Files,
    Disc,
}

pub fn is_zip(path: &Path) -> bool {
    if path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("zip"))
        .unwrap_or(false)
    {
        return true;
    }
    // Extensionless archive from a download: sniff the local-file-header magic.
    let mut buf = [0u8; 4];
    fs::File::open(path)
        .and_then(|mut f| io::Read::read_exact(&mut f, &mut buf))
        .map(|_| buf == [0x50, 0x4b, 0x03, 0x04])
        .unwrap_or(false)
}

pub fn is_dicomdir_name(path: &Path) -> bool {
    path.file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case("DICOMDIR"))
        .unwrap_or(false)
}

/// Find the DICOMDIR at the root of a folder (CD layout), case-insensitively.
pub fn find_dicomdir(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file() && is_dicomdir_name(&p) {
            return Some(p);
        }
    }
    None
}

/// Resolve a path component case-insensitively, tolerating the ISO 9660
/// version suffix (`IM000001;1`) that some burners leave on disc file names.
fn resolve_component(dir: &Path, component: &str, cache: &mut HashMap<PathBuf, Vec<String>>) -> Option<PathBuf> {
    let direct = dir.join(component);
    if direct.exists() {
        return Some(direct);
    }
    let names = cache.entry(dir.to_path_buf()).or_insert_with(|| {
        fs::read_dir(dir)
            .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default()
    });
    let wanted = component.to_ascii_lowercase();
    names
        .iter()
        .find(|name| {
            let lower = name.to_ascii_lowercase();
            lower == wanted || lower.trim_end_matches(";1") == wanted || lower == format!("{wanted}.")
        })
        .map(|name| dir.join(name))
}

/// Image files a DICOMDIR references, resolved against the media root.
/// Returns `(found, missing)` so the caller can fall back to a walk when the
/// index is stale (a common state for folders copied off a disc by hand).
pub fn dicomdir_files(dicomdir: &Path) -> Result<(Vec<PathBuf>, usize), String> {
    let root = dicomdir.parent().unwrap_or(Path::new("."));
    let obj = OpenFileOptions::new()
        .open_file(dicomdir)
        .map_err(|e| format!("DICOMDIR could not be read: {e}"))?;
    let records = obj
        .element_opt(tags::DIRECTORY_RECORD_SEQUENCE)
        .ok()
        .flatten()
        .and_then(|e| e.items().map(|items| items.to_vec()))
        .unwrap_or_default();

    let mut cache = HashMap::new();
    let mut found = Vec::new();
    let mut missing = 0usize;
    for record in &records {
        let Some(element) = record.element_opt(tags::REFERENCED_FILE_ID).ok().flatten() else {
            continue;
        };
        let Ok(raw) = element.to_str() else { continue };
        let parts: Vec<String> = raw
            .split('\\')
            .map(|p| p.trim().trim_end_matches('\0').to_string())
            .filter(|p| !p.is_empty())
            .collect();
        if parts.is_empty() {
            continue;
        }
        let mut current = root.to_path_buf();
        let mut ok = true;
        for part in &parts {
            match resolve_component(&current, part, &mut cache) {
                Some(next) => current = next,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if ok && current.is_file() {
            found.push(current);
        } else {
            missing += 1;
        }
    }
    found.sort();
    found.dedup();
    Ok((found, missing))
}

/// Every candidate file under a folder, skipping obvious non-images.
pub fn walk_folder(dir: &Path) -> Vec<PathBuf> {
    WalkDir::new(dir)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| {
            // Hidden folders (`.git`, `.Trashes`, `__MACOSX` resource forks).
            let name = e.file_name().to_string_lossy();
            e.depth() == 0 || !(name.starts_with('.') || name == "__MACOSX")
        })
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| !is_obviously_not_dicom(p))
        .collect()
}

/// Extract a zip into `dest` (once — an existing complete extraction is
/// reused, which is what makes re-opening a 600 MB archive instant).
pub fn extract_zip(archive: &Path, dest: &Path) -> Result<PathBuf, String> {
    let marker = dest.join(".complete");
    if marker.exists() {
        return Ok(dest.to_path_buf());
    }
    let _ = fs::remove_dir_all(dest);
    fs::create_dir_all(dest).map_err(|e| format!("Could not create the archive cache: {e}"))?;
    let file = fs::File::open(archive).map_err(|e| format!("Could not open the archive: {e}"))?;
    let mut zip = zip::ZipArchive::new(io::BufReader::new(file))
        .map_err(|e| format!("Not a readable zip archive: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = match zip.by_index(i) {
            Ok(entry) => entry,
            Err(zip::result::ZipError::UnsupportedArchive(msg)) if msg.contains("Password") => {
                return Err("This archive is password-protected. Extract it first, then open the folder.".into())
            }
            Err(e) => return Err(format!("Archive entry {i} could not be read: {e}")),
        };
        if entry.is_dir() {
            continue;
        }
        // `enclosed_name` rejects `../` and absolute paths (zip-slip).
        let Some(relative) = entry.enclosed_name() else { continue };
        let out_path = dest.join(&relative);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        io::copy(&mut entry, &mut out).map_err(|e| format!("Extracting {}: {e}", relative.display()))?;
    }
    fs::write(&marker, b"ok").map_err(|e| e.to_string())?;
    Ok(dest.to_path_buf())
}

/// A mounted optical or removable volume the user might want to open.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaVolume {
    pub path: String,
    pub label: String,
    /// `optical` for CD/DVD/BD, `removable` for USB sticks and card readers.
    pub kind: String,
    pub has_dicomdir: bool,
}

fn volume(path: PathBuf, label: String, kind: &str) -> MediaVolume {
    let has_dicomdir = find_dicomdir(&path).is_some();
    MediaVolume {
        path: path.to_string_lossy().into_owned(),
        label,
        kind: kind.to_string(),
        has_dicomdir,
    }
}

#[cfg(target_os = "windows")]
pub fn list_media() -> Vec<MediaVolume> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_CDROM: u32 = 5;
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let root = format!("{letter}:\\");
        let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
        let kind = match kind {
            DRIVE_CDROM => "optical",
            DRIVE_REMOVABLE => "removable",
            _ => continue,
        };
        // An empty tray reports the drive but fails the read.
        if fs::read_dir(&root).is_err() {
            continue;
        }
        out.push(volume(PathBuf::from(&root), format!("{letter}:"), kind));
    }
    out
}

#[cfg(target_os = "macos")]
pub fn list_media() -> Vec<MediaVolume> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir("/Volumes") else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        // The boot volume appears as a symlink to `/`.
        if fs::symlink_metadata(&path).map(|m| m.file_type().is_symlink()).unwrap_or(true) {
            continue;
        }
        let label = entry.file_name().to_string_lossy().into_owned();
        // Read-only mounts under /Volumes are almost always discs or disk images.
        let readonly = fs::metadata(&path).map(|m| m.permissions().readonly()).unwrap_or(false);
        out.push(volume(path, label, if readonly { "optical" } else { "removable" }));
    }
    out
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn list_media() -> Vec<MediaVolume> {
    let mut out = Vec::new();
    let Ok(mounts) = fs::read_to_string("/proc/mounts") else { return out };
    for line in mounts.lines() {
        let mut parts = line.split_whitespace();
        let (Some(_dev), Some(mount), Some(fstype)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let mount = mount.replace("\\040", " ");
        let optical = fstype == "iso9660" || fstype == "udf";
        let removable = mount.starts_with("/media/") || mount.starts_with("/run/media/");
        if !(optical || removable) {
            continue;
        }
        let path = PathBuf::from(&mount);
        let label = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| mount.clone());
        out.push(volume(path, label, if optical { "optical" } else { "removable" }));
    }
    out
}
