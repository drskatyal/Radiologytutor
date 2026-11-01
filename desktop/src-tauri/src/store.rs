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
