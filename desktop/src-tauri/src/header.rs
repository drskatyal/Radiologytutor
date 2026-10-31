//! One DICOM file's header, read up to (never including) the pixel data.
//!
//! The fields mirror `LocalInstanceHeader` in `lib/localStudy.ts` (camelCase
//! over the wire) so the renderer groups and orders a desktop scan with exactly
//! the same code the web viewer uses. The extra fields feed the corner overlay,
//! the series browser and the PET/CT fusion scaling.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use dicom_core::Tag;
use dicom_dictionary_std::tags;
use dicom_object::{DefaultDicomObject, OpenFileOptions};
use serde::{Deserialize, Serialize};

/// Bytes read to decide "is this DICOM at all" before handing the file to the
/// full parser. A 132-byte read costs the same as a stat on most filesystems.
const MAGIC_PROBE: usize = 132;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    /// Absolute path. Doubles as the stable key the renderer groups by.
    pub file_name: String,
    /// Index into the session's file registry — the only thing the `dicom://`
    /// protocol accepts, so the renderer can never ask for an arbitrary path.
    #[serde(default)]
    pub file_id: u32,
    pub size_bytes: u64,
    #[serde(default)]
    pub mtime: u64,

    #[serde(rename = "studyInstanceUID")]
    pub study_instance_uid: Option<String>,
    #[serde(rename = "seriesInstanceUID")]
    pub series_instance_uid: Option<String>,
    #[serde(rename = "sopInstanceUID")]
    pub sop_instance_uid: Option<String>,
    #[serde(rename = "sopClassUID")]
    pub sop_class_uid: Option<String>,
    #[serde(rename = "transferSyntaxUID")]
    pub transfer_syntax_uid: Option<String>,
    pub instance_number: Option<i64>,
    pub image_position_patient: Option<Vec<f64>>,
    pub image_orientation_patient: Option<Vec<f64>>,
    pub pixel_spacing: Option<Vec<f64>>,
    pub slice_thickness: Option<f64>,
    pub slice_location: Option<f64>,
    pub modality: Option<String>,
    pub series_number: Option<i64>,
    pub series_description: Option<String>,
    pub series_date: Option<String>,
    pub series_time: Option<String>,
    pub study_description: Option<String>,
    pub study_date: Option<String>,
    pub study_time: Option<String>,
    pub accession_number: Option<String>,
    pub body_part_examined: Option<String>,
    pub protocol_name: Option<String>,
    pub manufacturer: Option<String>,
    pub manufacturer_model_name: Option<String>,
    pub institution_name: Option<String>,
    pub number_of_frames: Option<i64>,
    pub rows: Option<i64>,
    pub columns: Option<i64>,
    pub bits_allocated: Option<i64>,
    pub photometric_interpretation: Option<String>,
    pub window_center: Option<f64>,
    pub window_width: Option<f64>,
    pub frame_time: Option<f64>,
    pub recommended_display_frame_rate: Option<f64>,
    pub image_type: Option<String>,
    #[serde(rename = "frameOfReferenceUID")]
    pub frame_of_reference_uid: Option<String>,
    pub acquisition_number: Option<i64>,
    pub echo_number: Option<i64>,

    // ---- Patient identifiers. Shown in the overlay; NEVER written to the
    // ---- on-disk scan cache (see `Header::without_phi`).
    pub patient_name: Option<String>,
    pub patient_id: Option<String>,
    pub patient_birth_date: Option<String>,
    pub patient_sex: Option<String>,
    pub patient_age: Option<String>,
    pub patient_weight: Option<f64>,
    pub referring_physician_name: Option<String>,
}

impl Header {
    /// A copy safe to persist: identity + geometry only.
    pub fn without_phi(&self) -> Header {
        Header {
            patient_name: None,
            patient_id: None,
            patient_birth_date: None,
            patient_sex: None,
            patient_age: None,
            patient_weight: None,
            referring_physician_name: None,
            institution_name: None,
            accession_number: None,
            ..self.clone()
        }
    }

    pub fn copy_patient_fields_from(&mut self, other: &Header) {
        self.patient_name = other.patient_name.clone();
        self.patient_id = other.patient_id.clone();
        self.patient_birth_date = other.patient_birth_date.clone();
        self.patient_sex = other.patient_sex.clone();
        self.patient_age = other.patient_age.clone();
        self.patient_weight = other.patient_weight;
        self.referring_physician_name = other.referring_physician_name.clone();
        self.institution_name = other.institution_name.clone();
        self.accession_number = other.accession_number.clone();
    }
}

/// Does this file start like DICOM Part 10? "DICM" at 128, or at 0 for the
/// preamble-less files some anonymisers write. Mirrors `hasDicomMagic`.
pub fn has_dicom_magic(path: &Path) -> bool {
    let mut buf = [0u8; MAGIC_PROBE];
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut filled = 0;
    while filled < MAGIC_PROBE {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return false,
        }
    }
    let at = |offset: usize| filled >= offset + 4 && &buf[offset..offset + 4] == b"DICM";
    at(128) || at(0)
}

/// Names that are never images: media junk, bundled viewers, the index itself.
/// Mirrors `isObviouslyNotDicom` + `isDicomDir` so the walk can skip them
/// without opening the file.
pub fn is_obviously_not_dicom(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if name.is_empty() || name.starts_with('.') || name == "dicomdir" || name == "thumbs.db" {
        return true;
    }
    const SKIP: &[&str] = &[
        "exe", "dll", "inf", "ini", "txt", "htm", "html", "xml", "pdf", "js", "css", "json", "png",
        "jpg", "jpeg", "gif", "bmp", "ico", "zip", "rar", "7z", "msi", "cab", "bat", "cmd", "sh",
        "app", "dylib", "plist", "md", "rtf", "doc", "docx", "mp4", "avi", "mov", "lnk", "url",
        "sys", "chm", "hlp", "cfg", "log", "csv", "nfo", "manifest", "jar", "class", "so", "dat",
        "db", "sqlite", "iso", "svg", "woff", "woff2", "ttf", "otf", "mp3", "wav",
    ];
    match name.rsplit_once('.') {
        Some((_, ext)) => SKIP.contains(&ext),
        None => false,
    }
}

fn text(obj: &DefaultDicomObject, tag: Tag) -> Option<String> {
    let element = obj.element_opt(tag).ok()??;
    let value = element.to_str().ok()?;
    let trimmed = value.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn int(obj: &DefaultDicomObject, tag: Tag) -> Option<i64> {
    let element = obj.element_opt(tag).ok()??;
    if let Ok(v) = element.to_int::<i64>() {
        return Some(v);
    }
    // IS with stray whitespace or a decimal point in the wild.
    text(obj, tag).and_then(|s| s.split('\\').next()?.trim().parse::<f64>().ok().map(|f| f as i64))
}

fn floats(obj: &DefaultDicomObject, tag: Tag) -> Option<Vec<f64>> {
    let element = obj.element_opt(tag).ok()??;
    if let Ok(values) = element.to_multi_float64() {
        if !values.is_empty() && values.iter().all(|v| v.is_finite()) {
            return Some(values);
        }
    }
    let raw = text(obj, tag)?;
    let values: Vec<f64> = raw
        .split('\\')
        .filter_map(|part| part.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn float(obj: &DefaultDicomObject, tag: Tag) -> Option<f64> {
    floats(obj, tag).and_then(|v| v.first().copied())
}

/// Parse one file's header. `None` when it is not readable DICOM.
pub fn read_header(path: &Path) -> Option<Header> {
    if !has_dicom_magic(path) {
        return None;
    }
    let obj = OpenFileOptions::new()
        .read_until(tags::PIXEL_DATA)
        .open_file(path)
        .ok()?;
    let meta = std::fs::metadata(path).ok();
    let sop_class = text(&obj, tags::SOP_CLASS_UID)
        .or_else(|| Some(obj.meta().media_storage_sop_class_uid().trim_end_matches('\0').to_string()));

    // Structured reports, presentation states, raw data, key-object notes and
    // encapsulated PDFs carry no pixels; they are not series the user scrolls.
    let has_image_geometry = obj.element_opt(tags::ROWS).ok().flatten().is_some();
    if !has_image_geometry {
        return None;
    }

    Some(Header {
        file_name: path.to_string_lossy().into_owned(),
        file_id: 0,
        size_bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
        mtime: meta.as_ref().map(mtime_secs).unwrap_or(0),
        study_instance_uid: text(&obj, tags::STUDY_INSTANCE_UID),
        series_instance_uid: text(&obj, tags::SERIES_INSTANCE_UID),
        sop_instance_uid: text(&obj, tags::SOP_INSTANCE_UID),
        sop_class_uid: sop_class,
        transfer_syntax_uid: Some(obj.meta().transfer_syntax().trim_end_matches('\0').to_string()),
        instance_number: int(&obj, tags::INSTANCE_NUMBER),
        image_position_patient: floats(&obj, tags::IMAGE_POSITION_PATIENT),
        image_orientation_patient: floats(&obj, tags::IMAGE_ORIENTATION_PATIENT),
        pixel_spacing: floats(&obj, tags::PIXEL_SPACING)
            .or_else(|| floats(&obj, tags::IMAGER_PIXEL_SPACING)),
        slice_thickness: float(&obj, tags::SLICE_THICKNESS),
        slice_location: float(&obj, tags::SLICE_LOCATION),
        modality: text(&obj, tags::MODALITY),
        series_number: int(&obj, tags::SERIES_NUMBER),
        series_description: text(&obj, tags::SERIES_DESCRIPTION),
        series_date: text(&obj, tags::SERIES_DATE),
        series_time: text(&obj, tags::SERIES_TIME),
        study_description: text(&obj, tags::STUDY_DESCRIPTION),
        study_date: text(&obj, tags::STUDY_DATE),
        study_time: text(&obj, tags::STUDY_TIME),
        accession_number: text(&obj, tags::ACCESSION_NUMBER),
        body_part_examined: text(&obj, tags::BODY_PART_EXAMINED),
        protocol_name: text(&obj, tags::PROTOCOL_NAME),
        manufacturer: text(&obj, tags::MANUFACTURER),
        manufacturer_model_name: text(&obj, tags::MANUFACTURER_MODEL_NAME),
        institution_name: text(&obj, tags::INSTITUTION_NAME),
        number_of_frames: int(&obj, tags::NUMBER_OF_FRAMES),
        rows: int(&obj, tags::ROWS),
        columns: int(&obj, tags::COLUMNS),
        bits_allocated: int(&obj, tags::BITS_ALLOCATED),
        photometric_interpretation: text(&obj, tags::PHOTOMETRIC_INTERPRETATION),
        window_center: float(&obj, tags::WINDOW_CENTER),
        window_width: float(&obj, tags::WINDOW_WIDTH),
        frame_time: float(&obj, tags::FRAME_TIME),
        recommended_display_frame_rate: float(&obj, tags::RECOMMENDED_DISPLAY_FRAME_RATE)
            .or_else(|| float(&obj, tags::CINE_RATE)),
        image_type: text(&obj, tags::IMAGE_TYPE),
        frame_of_reference_uid: text(&obj, tags::FRAME_OF_REFERENCE_UID),
        acquisition_number: int(&obj, tags::ACQUISITION_NUMBER),
        echo_number: int(&obj, tags::ECHO_NUMBERS),
        patient_name: text(&obj, tags::PATIENT_NAME),
        patient_id: text(&obj, tags::PATIENT_ID),
        patient_birth_date: text(&obj, tags::PATIENT_BIRTH_DATE),
        patient_sex: text(&obj, tags::PATIENT_SEX),
        patient_age: text(&obj, tags::PATIENT_AGE),
        patient_weight: float(&obj, tags::PATIENT_WEIGHT),
        referring_physician_name: text(&obj, tags::REFERRING_PHYSICIAN_NAME),
    })
}

pub fn mtime_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
