//! Anonymize on export.
//!
//! A header scrub modelled on the DICOM PS3.15 Basic Application Level
//! Confidentiality Profile, with the options a teaching export needs: keep age
//! and sex (clinically meaningful), drop private tags, and remap UIDs
//! consistently so an exported study still groups and orders correctly.
//!
//! What it does NOT do, stated rather than implied: it does not OCR pixels for
//! burned-in annotations. The export dialog says so (the same honesty
//! `lib/deid.ts` keeps with `pixelOcrScanned: false`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use dicom_core::{DataElement, PrimitiveValue, Tag, VR};
use dicom_dictionary_std::tags;
use dicom_object::{open_file, DefaultDicomObject};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

/// Removed outright. Retired tags stay on the list: old studies still carry them.
#[allow(deprecated)]
const REMOVE: &[Tag] = &[
    tags::PATIENT_BIRTH_TIME,
    tags::PATIENT_ADDRESS,
    tags::PATIENT_TELEPHONE_NUMBERS,
    tags::OTHER_PATIENT_I_DS,
    tags::OTHER_PATIENT_NAMES,
    tags::OTHER_PATIENT_I_DS_SEQUENCE,
    tags::PATIENT_BIRTH_NAME,
    tags::PATIENT_MOTHER_BIRTH_NAME,
    tags::MILITARY_RANK,
    tags::MEDICAL_RECORD_LOCATOR,
    tags::PERFORMING_PHYSICIAN_NAME,
    tags::OPERATORS_NAME,
    tags::PHYSICIANS_OF_RECORD,
    tags::NAME_OF_PHYSICIANS_READING_STUDY,
    tags::REQUESTING_PHYSICIAN,
    tags::INSTITUTION_NAME,
    tags::INSTITUTION_ADDRESS,
    tags::INSTITUTIONAL_DEPARTMENT_NAME,
    tags::STATION_NAME,
    tags::DEVICE_SERIAL_NUMBER,
    tags::ETHNIC_GROUP,
    tags::OCCUPATION,
    tags::ADDITIONAL_PATIENT_HISTORY,
    tags::PATIENT_COMMENTS,
    tags::ISSUER_OF_PATIENT_ID,
    tags::REFERENCED_PATIENT_SEQUENCE,
    tags::REQUEST_ATTRIBUTES_SEQUENCE,
    tags::PERFORMED_PROCEDURE_STEP_ID,
    tags::SCHEDULED_PROCEDURE_STEP_ID,
    tags::REQUESTED_PROCEDURE_ID,
    tags::ADMISSION_ID,
    tags::CURRENT_PATIENT_LOCATION,
    tags::PATIENT_INSURANCE_PLAN_CODE_SEQUENCE,
    tags::IMAGE_COMMENTS,
    tags::REFERRING_PHYSICIAN_ADDRESS,
    tags::REFERRING_PHYSICIAN_TELEPHONE_NUMBERS,
    tags::PATIENT_SIZE,
];

/// Kept present but emptied (Type 2 attributes the standard requires).
const EMPTY: &[(Tag, VR)] = &[
    (tags::PATIENT_BIRTH_DATE, VR::DA),
    (tags::ACCESSION_NUMBER, VR::SH),
    (tags::REFERRING_PHYSICIAN_NAME, VR::PN),
    (tags::STUDY_ID, VR::SH),
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnonymizeOptions {
    /// Replaces PatientName. Defaults to "ANONYMOUS".
    pub patient_name: Option<String>,
    /// Replaces PatientID. Defaults to "ANON".
    pub patient_id: Option<String>,
    #[serde(default = "yes")]
    pub keep_age_sex: bool,
    #[serde(default = "yes")]
    pub remove_private: bool,
    #[serde(default = "yes")]
    pub remap_uids: bool,
    #[serde(default)]
    pub keep_dates: bool,
}

fn yes() -> bool {
    true
}

impl Default for AnonymizeOptions {
    fn default() -> Self {
        AnonymizeOptions {
            patient_name: None,
            patient_id: None,
            keep_age_sex: true,
            remove_private: true,
            remap_uids: true,
            keep_dates: true,
        }
    }
}

/// Deterministic UID remap inside one export: the same source UID always maps
/// to the same new UID, so series still group and references stay intact.
#[derive(Default)]
pub struct UidMap {
    map: HashMap<String, String>,
    salt: u128,
}

impl UidMap {
    pub fn new() -> Self {
        let salt = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        UidMap { map: HashMap::new(), salt }
    }

    pub fn remap(&mut self, uid: &str) -> String {
        let uid = uid.trim_end_matches('\0').trim();
        if let Some(v) = self.map.get(uid) {
            return v.clone();
        }
        // 2.25.<decimal UUID-sized integer> per PS3.5 §B.2.
        use std::hash::{Hash, Hasher};
        let mut a = std::collections::hash_map::DefaultHasher::new();
        (uid, self.salt, 1u8).hash(&mut a);
        let mut b = std::collections::hash_map::DefaultHasher::new();
        (uid, self.salt, 2u8).hash(&mut b);
        let n = ((a.finish() as u128) << 64 | b.finish() as u128) >> 2;
        let new_uid = format!("2.25.{n}");
        self.map.insert(uid.to_string(), new_uid.clone());
        new_uid
    }
}

fn put_str(obj: &mut DefaultDicomObject, tag: Tag, vr: VR, value: &str) {
    obj.put(DataElement::new(tag, vr, PrimitiveValue::from(value)));
}

fn get_str(obj: &DefaultDicomObject, tag: Tag) -> Option<String> {
    obj.element_opt(tag)
        .ok()
        .flatten()
        .and_then(|e| e.to_str().ok().map(|s| s.trim_end_matches('\0').trim().to_string()))
}

pub fn anonymize_object(obj: &mut DefaultDicomObject, options: &AnonymizeOptions, uids: &mut UidMap) {
    for tag in REMOVE {
        obj.remove_element(*tag);
    }
    for (tag, vr) in EMPTY {
        if obj.element_opt(*tag).ok().flatten().is_some() {
            obj.put(DataElement::new(*tag, *vr, PrimitiveValue::Empty));
        }
    }
    put_str(obj, tags::PATIENT_NAME, VR::PN, options.patient_name.as_deref().unwrap_or("ANONYMOUS"));
    put_str(obj, tags::PATIENT_ID, VR::LO, options.patient_id.as_deref().unwrap_or("ANON"));
    if !options.keep_age_sex {
        obj.remove_element(tags::PATIENT_AGE);
        obj.remove_element(tags::PATIENT_SEX);
        obj.remove_element(tags::PATIENT_WEIGHT);
    }
    if !options.keep_dates {
        for tag in [
            tags::STUDY_DATE,
            tags::SERIES_DATE,
            tags::ACQUISITION_DATE,
            tags::CONTENT_DATE,
        ] {
            if obj.element_opt(tag).ok().flatten().is_some() {
                obj.put(DataElement::new(tag, VR::DA, PrimitiveValue::Empty));
            }
        }
        obj.remove_element(tags::ACQUISITION_DATE_TIME);
    }
    if options.remove_private {
        let private: Vec<Tag> = obj.tags().filter(|t| t.group() % 2 == 1).collect();
        for tag in private {
            obj.remove_element(tag);
        }
    }
    if options.remap_uids {
        for tag in [
            tags::STUDY_INSTANCE_UID,
            tags::SERIES_INSTANCE_UID,
            tags::SOP_INSTANCE_UID,
            tags::FRAME_OF_REFERENCE_UID,
        ] {
            if let Some(old) = get_str(obj, tag) {
                if !old.is_empty() {
                    let new_uid = uids.remap(&old);
                    put_str(obj, tag, VR::UI, &new_uid);
                }
            }
        }
        if let Some(sop) = get_str(obj, tags::SOP_INSTANCE_UID) {
            obj.update_meta(|meta| meta.media_storage_sop_instance_uid = sop);
        }
    }
    put_str(obj, tags::PATIENT_IDENTITY_REMOVED, VR::CS, "YES");
    put_str(
        obj,
        tags::DEIDENTIFICATION_METHOD,
        VR::LO,
        "RadLearn Viewer: PS3.15 basic profile header scrub; pixels not inspected",
    );
}

/// Anonymized Part 10 bytes for one file (the sync upload path).
pub fn anonymize_to_bytes(path: &Path, options: &AnonymizeOptions, uids: &mut UidMap) -> Result<Vec<u8>, String> {
    let mut obj = open_file(path).map_err(|e| format!("{}: {e}", path.display()))?;
    anonymize_object(&mut obj, options, uids);
    let mut out = Vec::new();
    obj.write_all(&mut out).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub written: usize,
    pub failed: usize,
    pub errors: Vec<String>,
    pub destination: String,
}

/// Write an anonymized copy of `paths` under `destination/<series>/IMxxxxx.dcm`.
#[tauri::command]
pub async fn export_anonymized_dicom(
    app: tauri::AppHandle,
    paths: Vec<String>,
    destination: String,
    options: Option<AnonymizeOptions>,
) -> Result<ExportResult, String> {
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let dest = PathBuf::from(&destination);
        std::fs::create_dir_all(&dest).map_err(|e| format!("Could not create {destination}: {e}"))?;
        let mut uids = UidMap::new();
        let mut series_dirs: HashMap<String, (PathBuf, usize)> = HashMap::new();
        let total = paths.len();
        let mut written = 0;
        let mut errors = Vec::new();
        for (i, source) in paths.iter().enumerate() {
            let result = (|| -> Result<(), String> {
                let mut obj = open_file(source).map_err(|e| e.to_string())?;
                let series = get_str(&obj, tags::SERIES_INSTANCE_UID).unwrap_or_default();
                let next = series_dirs.len() + 1;
                let (dir, count) = series_dirs
                    .entry(series)
                    .or_insert_with(|| (dest.join(format!("SE{next:04}")), 0));
                std::fs::create_dir_all(&*dir).map_err(|e| e.to_string())?;
                *count += 1;
                let file = dir.join(format!("IM{:05}.dcm", *count));
                anonymize_object(&mut obj, &options, &mut uids);
                obj.write_to_file(&file).map_err(|e| e.to_string())
            })();
            match result {
                Ok(()) => written += 1,
                Err(e) => errors.push(format!("{source}: {e}")),
            }
            if i % 16 == 0 || i + 1 == total {
                let _ = app.emit("export-progress", ExportProgress { done: i + 1, total });
            }
        }
        Ok(ExportResult {
            written,
            failed: errors.len(),
            errors: errors.into_iter().take(20).collect(),
            destination,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
