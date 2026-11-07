//! Non-image DICOM objects a reader still needs: Structured Reports (the
//! measurements and findings a modality or PACS attached) and Key Object
//! Selection notes (the radiologist's "key images"). The header scan skips
//! anything without pixel geometry; these come back here instead.

use std::path::Path;

use dicom_core::Tag;
use dicom_dictionary_std::tags;
use dicom_object::{InMemDicomObject, OpenFileOptions};
use serde::Serialize;

const SR_PREFIX: &str = "1.2.840.10008.5.1.4.1.1.88.";
const KEY_OBJECT_SELECTION: &str = "1.2.840.10008.5.1.4.1.1.88.59";

const CONTENT_SEQUENCE: Tag = Tag(0x0040, 0xA730);
const VALUE_TYPE: Tag = Tag(0x0040, 0xA040);
const CONCEPT_NAME_CODE_SEQUENCE: Tag = Tag(0x0040, 0xA043);
const CONCEPT_CODE_SEQUENCE: Tag = Tag(0x0040, 0xA168);
const TEXT_VALUE: Tag = Tag(0x0040, 0xA160);
const MEASURED_VALUE_SEQUENCE: Tag = Tag(0x0040, 0xA300);
const NUMERIC_VALUE: Tag = Tag(0x0040, 0xA30A);
const MEASUREMENT_UNITS_CODE_SEQUENCE: Tag = Tag(0x0040, 0x08EA);
const PERSON_NAME: Tag = Tag(0x0040, 0xA123);
const DATE: Tag = Tag(0x0040, 0xA121);
const UID: Tag = Tag(0x0040, 0xA124);
const REFERENCED_SOP_SEQUENCE: Tag = Tag(0x0008, 0x1199);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    /// "sr" or "ko".
    pub kind: &'static str,
    pub file_name: String,
    pub study_instance_uid: Option<String>,
    pub series_instance_uid: Option<String>,
    pub sop_instance_uid: Option<String>,
    /// Document title (root concept name), e.g. "Imaging Measurement Report".
    pub title: String,
    pub date: Option<String>,
    /// The content tree, one line per item, indented two spaces per level.
    pub lines: Vec<String>,
    /// SOP Instance UIDs of the images it points at (key images, measured images).
    pub references: Vec<String>,
}

fn text(obj: &InMemDicomObject, tag: Tag) -> Option<String> {
    let v = obj.element_opt(tag).ok()??.to_str().ok()?;
    let t = v.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string();
    (!t.is_empty()).then_some(t)
}

fn items(obj: &InMemDicomObject, tag: Tag) -> &[InMemDicomObject] {
    obj.element_opt(tag).ok().flatten().and_then(|e| e.items()).unwrap_or(&[])
}

fn code_meaning(obj: &InMemDicomObject, seq: Tag) -> Option<String> {
    items(obj, seq).first().and_then(|i| text(i, tags::CODE_MEANING))
}

fn walk(obj: &InMemDicomObject, depth: usize, lines: &mut Vec<String>, refs: &mut Vec<String>) {
    for item in items(obj, CONTENT_SEQUENCE) {
        let name = code_meaning(item, CONCEPT_NAME_CODE_SEQUENCE);
        let value_type = text(item, VALUE_TYPE).unwrap_or_default();
        let value = match value_type.as_str() {
            "TEXT" => text(item, TEXT_VALUE),
            "CODE" => code_meaning(item, CONCEPT_CODE_SEQUENCE),
            "NUM" => items(item, MEASURED_VALUE_SEQUENCE).first().and_then(|m| {
                let n = text(m, NUMERIC_VALUE)?;
                let unit = items(m, MEASUREMENT_UNITS_CODE_SEQUENCE).first().and_then(|u| text(u, tags::CODE_VALUE));
                Some(match unit.as_deref() {
                    Some(u) if u != "1" => format!("{n} {u}"),
                    _ => n,
                })
            }),
            "PNAME" => text(item, PERSON_NAME).map(|p| p.replace('^', " ").trim().to_string()),
            "DATE" => text(item, DATE),
            "UIDREF" => text(item, UID),
            "IMAGE" | "COMPOSITE" => {
                let uid = items(item, REFERENCED_SOP_SEQUENCE).first().and_then(|r| text(r, tags::REFERENCED_SOP_INSTANCE_UID));
                if let Some(u) = &uid {
                    if !refs.contains(u) {
                        refs.push(u.clone());
                    }
                }
                Some("image".into())
            }
            _ => None,
        };
        let line = match (name, value) {
            (Some(n), Some(v)) if value_type != "CONTAINER" => format!("{n}: {v}"),
            (Some(n), _) => n,
            (None, Some(v)) => v,
            (None, None) => String::new(),
        };
        if !line.is_empty() && value_type != "IMAGE" {
            lines.push(format!("{}{}", "  ".repeat(depth), line));
        }
        walk(item, depth + 1, lines, refs);
    }
}

/// Read an SR or KO file; `None` for anything else.
pub fn read_document(path: &Path) -> Option<Document> {
    let obj = OpenFileOptions::new().open_file(path).ok()?;
    let sop_class = text(&obj, tags::SOP_CLASS_UID)
        .unwrap_or_else(|| obj.meta().media_storage_sop_class_uid().trim_end_matches('\0').to_string());
    if !sop_class.starts_with(SR_PREFIX) {
        return None;
    }
    let kind = if sop_class == KEY_OBJECT_SELECTION { "ko" } else { "sr" };
    let mut lines = Vec::new();
    let mut references = Vec::new();
    walk(&obj, 0, &mut lines, &mut references);
    Some(Document {
        kind,
        file_name: path.to_string_lossy().into_owned(),
        study_instance_uid: text(&obj, tags::STUDY_INSTANCE_UID),
        series_instance_uid: text(&obj, tags::SERIES_INSTANCE_UID),
        sop_instance_uid: text(&obj, tags::SOP_INSTANCE_UID),
        title: code_meaning(&obj, CONCEPT_NAME_CODE_SEQUENCE)
            .or_else(|| text(&obj, tags::SERIES_DESCRIPTION))
            .unwrap_or_else(|| if kind == "ko" { "Key images".into() } else { "Structured report".into() }),
        date: text(&obj, tags::CONTENT_DATE).or_else(|| text(&obj, tags::STUDY_DATE)),
        lines,
        references,
    })
}

#[cfg(test)]
mod tests {
    use super::read_document;

    /// FLOWRAD_FIXTURES=… cargo test documents (desktop/scripts/make-fixtures.py builds documents/).
    #[test]
    fn reads_structured_report_and_key_image_note() {
        let Ok(root) = crate::flowrad_env("FIXTURES") else { return };
        let dir = std::path::Path::new(&root).join("documents");
        let sr = read_document(&dir.join("SR_measurements.dcm")).expect("SR");
        assert_eq!(sr.kind, "sr");
        assert_eq!(sr.title, "Imaging Measurement Report");
        assert!(sr.lines.iter().any(|l| l.trim() == "Finding: Right lower lobe nodule, solid."), "{:?}", sr.lines);
        assert!(sr.lines.iter().any(|l| l.trim() == "Length: 12.4 mm"), "{:?}", sr.lines);
        assert!(sr.lines.iter().any(|l| l.trim() == "Finding Site: Lower lobe of right lung"), "{:?}", sr.lines);
        assert_eq!(sr.references.len(), 1);

        let ko = read_document(&dir.join("KO_key_images.dcm")).expect("KO");
        assert_eq!(ko.kind, "ko");
        assert_eq!(ko.references.len(), 2);
        assert!(ko.lines.iter().any(|l| l.contains("Nodule and adjacent slice.")));
        assert!(ko.study_instance_uid.is_some());

        // An image file is not a document.
        let img = std::fs::read_dir(std::path::Path::new(&root).join("ct-phantom/axial-5mm")).unwrap().flatten().next().unwrap();
        assert!(read_document(&img.path()).is_none());
    }
}
