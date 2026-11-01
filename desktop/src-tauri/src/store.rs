//! Local study history and settings, as small JSON files in the app data dir.
//!
//! History stores what is needed to re-open a study and recognise it in a
//! list — source paths, study description, date, modalities, counts — and by
//! default no patient identifiers (docs/DESKTOP_PLAN.md §5). The renderer owns
//! the entry shape; this module only persists, dedupes and caps it.

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::Manager;

const HISTORY_CAP: usize = 1000;

/// Data folders of earlier builds (before the FlowRad Viewer rename and the
/// final bundle identifier). Their settings and history move to the current
/// folder on first launch.
const LEGACY_IDENTIFIERS: [&str; 2] = ["app.radlearn.viewer", "com.flowrad.tori"];

/// Copy the top-level files (settings.json, history.json, ...) of `old` into
/// `new` where `new` has no file of that name yet. Never overwrites, never
/// deletes: the old folder stays as a backup. Sub-folders (the web view's own
/// storage, caches) are left behind; they are rebuilt. Returns files copied.
pub fn migrate_from(old: &std::path::Path, new: &std::path::Path) -> usize {
    let Ok(entries) = fs::read_dir(old) else { return 0 };
    if fs::create_dir_all(new).is_err() {
        return 0;
    }
    let mut copied = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let target = new.join(entry.file_name());
        if target.exists() {
            continue;
        }
        if fs::copy(&path, &target).is_ok() {
            copied += 1;
        }
    }
    copied
}

/// Run once at startup, before the window opens.
pub fn migrate_legacy_data(app: &tauri::AppHandle) {
    let Ok(new) = app.path().app_data_dir() else { return };
    let Some(parent) = new.parent() else { return };
    for id in LEGACY_IDENTIFIERS {
        let old = parent.join(id);
        if old != new && old.is_dir() {
            let n = migrate_from(&old, &new);
            if n > 0 {
                eprintln!("migrated {n} file(s) from {}", old.display());
            }
        }
    }
}

fn data_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

fn read_json(path: &PathBuf, fallback: Value) -> Value {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(fallback)
}

pub(crate) fn write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_list(app: tauri::AppHandle) -> Result<Value, String> {
    Ok(read_json(&data_file(&app, "history.json")?, json!([])))
}

/// Insert or refresh an entry (matched on `key`), newest first.
#[tauri::command]
pub fn history_record(app: tauri::AppHandle, entry: Value) -> Result<Value, String> {
    let path = data_file(&app, "history.json")?;
    let key = entry.get("key").and_then(Value::as_str).ok_or("history entry needs a key")?.to_string();
    let mut list = match read_json(&path, json!([])) {
        Value::Array(items) => items,
        _ => Vec::new(),
    };
    list.retain(|e| e.get("key").and_then(Value::as_str) != Some(key.as_str()));
    list.insert(0, entry);
    list.truncate(HISTORY_CAP);
    let value = Value::Array(list);
    write_json(&path, &value)?;
    Ok(value)
}

#[tauri::command]
pub fn history_remove(app: tauri::AppHandle, key: String) -> Result<Value, String> {
    let path = data_file(&app, "history.json")?;
    let mut list = match read_json(&path, json!([])) {
        Value::Array(items) => items,
        _ => Vec::new(),
    };
    list.retain(|e| e.get("key").and_then(Value::as_str) != Some(key.as_str()));
    let value = Value::Array(list);
    write_json(&path, &value)?;
    Ok(value)
}

#[tauri::command]
pub fn history_clear(app: tauri::AppHandle) -> Result<(), String> {
    write_json(&data_file(&app, "history.json")?, &json!([]))
}

#[tauri::command]
pub fn settings_get(app: tauri::AppHandle) -> Result<Value, String> {
    Ok(read_json(&data_file(&app, "settings.json")?, json!({})))
}

/// Shallow-merge a patch into the stored settings and return the result.
#[tauri::command]
pub fn settings_set(app: tauri::AppHandle, patch: Value) -> Result<Value, String> {
    let path = data_file(&app, "settings.json")?;
    let mut current = match read_json(&path, json!({})) {
        Value::Object(map) => map,
        _ => Default::default(),
    };
    if let Value::Object(map) = patch {
        for (k, v) in map {
            current.insert(k, v);
        }
    }
    let value = Value::Object(current);
    write_json(&path, &value)?;
    Ok(value)
}

pub(crate) fn data_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    data_file(app, name)
}

#[cfg(test)]
mod migration_tests {
    use super::migrate_from;
    use std::fs;

    #[test]
    fn copies_missing_files_never_overwrites_skips_folders() {
        let root = std::env::temp_dir().join(format!("flowrad-migrate-{}", std::process::id()));
        let (old, new) = (root.join("app.radlearn.viewer"), root.join("app.flowrad.viewer"));
        fs::create_dir_all(old.join("EBWebView")).unwrap();
        fs::write(old.join("settings.json"), "{\"old\":true}").unwrap();
        fs::write(old.join("history.json"), "[1]").unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("settings.json"), "{\"new\":true}").unwrap();

        assert_eq!(migrate_from(&old, &new), 1, "only history.json is missing");
        assert_eq!(fs::read_to_string(new.join("settings.json")).unwrap(), "{\"new\":true}", "never overwrites");
        assert_eq!(fs::read_to_string(new.join("history.json")).unwrap(), "[1]");
        assert!(!new.join("EBWebView").exists(), "web view storage is not copied");
        assert!(old.join("settings.json").exists(), "old folder kept as a backup");
        assert_eq!(migrate_from(&old, &new), 0, "idempotent");
        assert_eq!(migrate_from(&root.join("missing"), &new), 0);
        let _ = fs::remove_dir_all(&root);
    }
}
