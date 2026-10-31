//! PET tags needed for SUV (body-weight) scaling, shaped like the
//! `InstanceMetadata` that `@cornerstonejs/calculate-suv` expects.
//!
//! These live outside `Header` on purpose: they are only read when the user
//! opens a fusion view, and the radiopharmaceutical sequence is not worth
//! parsing for every file of every study.

use std::path::Path;

use dicom_core::Tag;
use dicom_dictionary_std::tags;
use dicom_object::{DefaultDicomObject, InMemDicomObject, OpenFileOptions};
use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct PetMeta {
    pub corrected_image: Vec<String>,
    pub units: Option<String>,
    pub radionuclide_half_life: Option<f64>,
    pub radionuclide_total_dose: Option<f64>,
    pub decay_correction: Option<String>,
    pub patient_weight: Option<f64>,
    pub patient_size: Option<f64>,
    pub patient_sex: Option<String>,
    pub series_date: Option<String>,
    pub series_time: Option<String>,
    pub acquisition_date: Option<String>,
    pub acquisition_time: Option<String>,
    pub radiopharmaceutical_start_time: Option<String>,
    pub radiopharmaceutical_start_date_time: Option<String>,
    pub frame_reference_time: Option<f64>,
    pub actual_frame_duration: Option<f64>,
}

fn s_root(obj: &DefaultDicomObject, tag: Tag) -> Option<String> {
    obj.element_opt(tag)
        .ok()
        .flatten()
        .and_then(|e| e.to_str().ok())
        .map(|v| v.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string())
        .filter(|v| !v.is_empty())
}

fn s_item(obj: &InMemDicomObject, tag: Tag) -> Option<String> {
    obj.element_opt(tag)
        .ok()
        .flatten()
        .and_then(|e| e.to_str().ok())
        .map(|v| v.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string())
        .filter(|v| !v.is_empty())
}

fn f(v: Option<String>) -> Option<f64> {
    v.and_then(|s| s.split('\\').next().and_then(|x| x.trim().parse::<f64>().ok()))
}

pub fn read_pet(path: &Path) -> Option<PetMeta> {
    let obj = OpenFileOptions::new().read_until(tags::PIXEL_DATA).open_file(path).ok()?;
    let mut meta = PetMeta {
        corrected_image: s_root(&obj, tags::CORRECTED_IMAGE)
            .map(|v| v.split('\\').map(|p| p.trim().to_string()).collect())
            .unwrap_or_default(),
        units: s_root(&obj, tags::UNITS),
        decay_correction: s_root(&obj, tags::DECAY_CORRECTION),
        patient_weight: f(s_root(&obj, tags::PATIENT_WEIGHT)),
        patient_size: f(s_root(&obj, tags::PATIENT_SIZE)),
        patient_sex: s_root(&obj, tags::PATIENT_SEX),
        series_date: s_root(&obj, tags::SERIES_DATE),
        series_time: s_root(&obj, tags::SERIES_TIME),
        acquisition_date: s_root(&obj, tags::ACQUISITION_DATE),
        acquisition_time: s_root(&obj, tags::ACQUISITION_TIME),
        frame_reference_time: f(s_root(&obj, tags::FRAME_REFERENCE_TIME)),
        actual_frame_duration: f(s_root(&obj, tags::ACTUAL_FRAME_DURATION)),
        ..Default::default()
    };
    if let Some(item) = obj
        .element_opt(tags::RADIOPHARMACEUTICAL_INFORMATION_SEQUENCE)
        .ok()
        .flatten()
        .and_then(|e| e.items().and_then(|items| items.first().cloned()))
    {
        meta.radionuclide_total_dose = f(s_item(&item, tags::RADIONUCLIDE_TOTAL_DOSE));
        meta.radionuclide_half_life = f(s_item(&item, tags::RADIONUCLIDE_HALF_LIFE));
        meta.radiopharmaceutical_start_time = s_item(&item, tags::RADIOPHARMACEUTICAL_START_TIME);
        meta.radiopharmaceutical_start_date_time = s_item(&item, tags::RADIOPHARMACEUTICAL_START_DATE_TIME);
    }
    Some(meta)
}
