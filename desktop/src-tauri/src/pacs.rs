//! PACS query / retrieve. Opt-in, user-configured, and the only part of the
//! viewer besides sync and the updater that touches a network.
//!
//! Two protocols, one model:
//! - **DIMSE**: C-ECHO, study-root C-FIND at STUDY level, and C-MOVE to a
//!   storage SCP this module runs for the duration of the move. The PACS must
//!   know our AE title, host and port, as with any DICOM viewer.
//! - **DICOMweb**: QIDO-RS search, then WADO-RS per instance, 8 at a time.
//!
//! Either way the study lands in the app cache and opens through the same
//! local pipeline as a folder, so MPR, fusion, export and anonymisation all
//! work on PACS studies, and keep working offline once retrieved.

use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dicom_core::{dicom_value, DataElement, PrimitiveValue, Tag, VR};
use dicom_dictionary_std::tags;
use dicom_encoding::transfer_syntax::TransferSyntaxIndex;
use dicom_object::{FileMetaTableBuilder, InMemDicomObject, StandardDataDictionary};
use dicom_transfer_syntax_registry::{entries, TransferSyntaxRegistry};
use dicom_ul::association::{ClientAssociationOptions, ServerAssociationOptions};
use dicom_ul::pdu::{PDataValue, PDataValueType, Pdu};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};

const STUDY_ROOT_FIND: &str = "1.2.840.10008.5.1.4.1.2.2.1";
const STUDY_ROOT_MOVE: &str = "1.2.840.10008.5.1.4.1.2.2.2";
const VERIFICATION: &str = "1.2.840.10008.1.1";

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PacsNode {
    #[serde(rename_all = "camelCase")]
    Dimse {
        host: String,
        port: u16,
        called_ae: String,
        calling_ae: String,
        /// Our storage SCP port for C-MOVE (default 11112).
        local_port: Option<u16>,
    },
    #[serde(rename_all = "camelCase")]
    Dicomweb {
        url: String,
        /// "user:password" (Basic) or a bearer token.
        username: Option<String>,
        password: Option<String>,
        token: Option<String>,
    },
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyQuery {
    pub patient_name: Option<String>,
    pub patient_id: Option<String>,
    /// DICOM range, e.g. "20240101-20240131" or "20240115".
    pub study_date: Option<String>,
    pub modality: Option<String>,
    pub accession_number: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyRow {
    #[serde(rename = "studyInstanceUID")]
    pub study_instance_uid: String,
    pub patient_name: Option<String>,
    pub patient_id: Option<String>,
    pub patient_birth_date: Option<String>,
    pub study_date: Option<String>,
    pub study_time: Option<String>,
    pub study_description: Option<String>,
    pub accession_number: Option<String>,
    pub modalities: Vec<String>,
    pub series_count: Option<u32>,
    pub instance_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetrieveProgress {
    received: usize,
    total: Option<usize>,
}

fn err<E: std::fmt::Display>(context: &str) -> impl Fn(E) -> String + '_ {
    move |e| format!("{context}: {e}")
}

// ───────────────────────────── DIMSE ─────────────────────────────

fn implicit() -> dicom_encoding::TransferSyntax {
    entries::IMPLICIT_VR_LITTLE_ENDIAN.erased()
}

fn command(field: u16, sop_class: &str, msg_id: u16, has_dataset: bool, extra: Vec<dicom_object::mem::InMemElement>) -> InMemDicomObject<StandardDataDictionary> {
    let mut elements = vec![
        DataElement::new(tags::AFFECTED_SOP_CLASS_UID, VR::UI, PrimitiveValue::from(sop_class)),
        DataElement::new(tags::COMMAND_FIELD, VR::US, dicom_value!(U16, [field])),
        DataElement::new(tags::MESSAGE_ID, VR::US, dicom_value!(U16, [msg_id])),
        DataElement::new(tags::PRIORITY, VR::US, dicom_value!(U16, [0x0000])),
        DataElement::new(
            tags::COMMAND_DATA_SET_TYPE,
            VR::US,
            dicom_value!(U16, [if has_dataset { 0x0001 } else { 0x0101 }]),
        ),
    ];
    elements.extend(extra);
    InMemDicomObject::command_from_element_iter(elements)
}

fn connect(node_host: &str, port: u16, called: &str, calling: &str, abstract_syntax: &str) -> Result<dicom_ul::ClientAssociation<std::net::TcpStream>, String> {
    ClientAssociationOptions::new()
        .with_abstract_syntax(abstract_syntax)
        .calling_ae_title(calling.to_string())
        .called_ae_title(called.to_string())
        .connection_timeout(Duration::from_secs(8))
        .read_timeout(Duration::from_secs(60))
        .establish_with(&format!("{node_host}:{port}"))
        .map_err(|e| format!("Could not associate with {called}@{node_host}:{port}: {e}"))
}

fn send_command(
    scu: &mut dicom_ul::ClientAssociation<std::net::TcpStream>,
    pc_id: u8,
    cmd: &InMemDicomObject<StandardDataDictionary>,
    dataset: Option<(&InMemDicomObject<StandardDataDictionary>, &dicom_encoding::TransferSyntax)>,
) -> Result<(), String> {
    let mut cmd_data = Vec::new();
    cmd.write_dataset_with_ts(&mut cmd_data, &implicit()).map_err(err("encode command"))?;
    scu.send(&Pdu::PData {
        data: vec![PDataValue { presentation_context_id: pc_id, value_type: PDataValueType::Command, is_last: true, data: cmd_data }],
    })
    .map_err(err("send command"))?;
    if let Some((ds, ts)) = dataset {
        let mut data = Vec::new();
        ds.write_dataset_with_ts(&mut data, ts).map_err(err("encode identifier"))?;
        scu.send(&Pdu::PData {
            data: vec![PDataValue { presentation_context_id: pc_id, value_type: PDataValueType::Data, is_last: true, data }],
        })
        .map_err(err("send identifier"))?;
    }
    Ok(())
}

fn status_of(cmd: &InMemDicomObject<StandardDataDictionary>) -> Option<u16> {
    cmd.element(tags::STATUS).ok().and_then(|e| e.to_int::<u16>().ok())
}

fn text(obj: &InMemDicomObject<StandardDataDictionary>, tag: Tag) -> Option<String> {
    obj.element(tag)
        .ok()
        .and_then(|e| e.to_str().ok())
        .map(|s| s.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string())
        .filter(|s| !s.is_empty())
}

fn dimse_echo(host: &str, port: u16, called: &str, calling: &str) -> Result<(), String> {
    let mut scu = connect(host, port, called, calling, VERIFICATION)?;
    let pc = scu.presentation_contexts().first().ok_or("No presentation context accepted")?.id;
    let cmd = InMemDicomObject::command_from_element_iter([
        DataElement::new(tags::AFFECTED_SOP_CLASS_UID, VR::UI, PrimitiveValue::from(VERIFICATION)),
        DataElement::new(tags::COMMAND_FIELD, VR::US, dicom_value!(U16, [0x0030])),
        DataElement::new(tags::MESSAGE_ID, VR::US, dicom_value!(U16, [1])),
        DataElement::new(tags::COMMAND_DATA_SET_TYPE, VR::US, dicom_value!(U16, [0x0101])),
    ]);
    send_command(&mut scu, pc, &cmd, None)?;
    match scu.receive().map_err(err("C-ECHO response"))? {
        Pdu::PData { data } if !data.is_empty() => {
            let rsp = InMemDicomObject::read_dataset_with_ts(&data[0].data[..], &implicit()).map_err(err("decode"))?;
            let _ = scu.release();
            match status_of(&rsp) {
                Some(0) => Ok(()),
                other => Err(format!("C-ECHO failed with status {other:?}")),
            }
        }
        other => Err(format!("Unexpected C-ECHO response: {other:?}")),
    }
}

fn study_identifier(q: &StudyQuery) -> InMemDicomObject<StandardDataDictionary> {
    let s = |v: &Option<String>| v.clone().unwrap_or_default();
    let name = q.patient_name.as_ref().map(|n| {
        let n = n.trim();
        if n.is_empty() || n.contains('*') { n.to_string() } else { format!("{n}*") }
    });
    InMemDicomObject::from_element_iter([
        DataElement::new(tags::QUERY_RETRIEVE_LEVEL, VR::CS, PrimitiveValue::from("STUDY")),
        DataElement::new(tags::PATIENT_NAME, VR::PN, PrimitiveValue::from(name.unwrap_or_default())),
        DataElement::new(tags::PATIENT_ID, VR::LO, PrimitiveValue::from(s(&q.patient_id))),
        DataElement::new(tags::PATIENT_BIRTH_DATE, VR::DA, PrimitiveValue::from("")),
        DataElement::new(tags::STUDY_DATE, VR::DA, PrimitiveValue::from(s(&q.study_date))),
        DataElement::new(tags::STUDY_TIME, VR::TM, PrimitiveValue::from("")),
        DataElement::new(tags::ACCESSION_NUMBER, VR::SH, PrimitiveValue::from(s(&q.accession_number))),
        DataElement::new(tags::STUDY_DESCRIPTION, VR::LO, PrimitiveValue::from("")),
        DataElement::new(tags::MODALITIES_IN_STUDY, VR::CS, PrimitiveValue::from(s(&q.modality))),
        DataElement::new(tags::STUDY_INSTANCE_UID, VR::UI, PrimitiveValue::from("")),
        DataElement::new(tags::NUMBER_OF_STUDY_RELATED_SERIES, VR::IS, PrimitiveValue::from("")),
        DataElement::new(tags::NUMBER_OF_STUDY_RELATED_INSTANCES, VR::IS, PrimitiveValue::from("")),
    ])
}

fn row_from(ds: &InMemDicomObject<StandardDataDictionary>) -> Option<StudyRow> {
    Some(StudyRow {
        study_instance_uid: text(ds, tags::STUDY_INSTANCE_UID)?,
        patient_name: text(ds, tags::PATIENT_NAME),
        patient_id: text(ds, tags::PATIENT_ID),
        patient_birth_date: text(ds, tags::PATIENT_BIRTH_DATE),
        study_date: text(ds, tags::STUDY_DATE),
        study_time: text(ds, tags::STUDY_TIME),
        study_description: text(ds, tags::STUDY_DESCRIPTION),
        accession_number: text(ds, tags::ACCESSION_NUMBER),
        modalities: text(ds, tags::MODALITIES_IN_STUDY)
            .map(|m| m.split('\\').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
            .unwrap_or_default(),
        series_count: text(ds, tags::NUMBER_OF_STUDY_RELATED_SERIES).and_then(|v| v.parse().ok()),
        instance_count: text(ds, tags::NUMBER_OF_STUDY_RELATED_INSTANCES).and_then(|v| v.parse().ok()),
    })
}

/// Read one DIMSE response: the command, plus its data set when it has one.
fn receive_response(
    scu: &mut dicom_ul::ClientAssociation<std::net::TcpStream>,
    ts: &dicom_encoding::TransferSyntax,
) -> Result<(InMemDicomObject<StandardDataDictionary>, Option<InMemDicomObject<StandardDataDictionary>>), String> {
    let pdu = scu.receive().map_err(err("response"))?;
    let Pdu::PData { data } = pdu else {
        return Err(format!("Unexpected PDU from the PACS: {}", pdu.short_description()));
    };
    let first = data.first().ok_or("Empty response")?;
    let cmd = InMemDicomObject::read_dataset_with_ts(&first.data[..], &implicit()).map_err(err("decode command"))?;
    let has_dataset = cmd
        .element(tags::COMMAND_DATA_SET_TYPE)
        .ok()
        .and_then(|e| e.to_int::<u16>().ok())
        .map(|v| v != 0x0101)
        .unwrap_or(false);
    if !has_dataset {
        return Ok((cmd, None));
    }
    let ds = if let Some(second) = data.get(1) {
        InMemDicomObject::read_dataset_with_ts(&second.data[..], ts).map_err(err("decode identifier"))?
    } else {
        let mut buf = Vec::new();
        scu.receive_pdata().read_to_end(&mut buf).map_err(err("identifier"))?;
        InMemDicomObject::read_dataset_with_ts(&buf[..], ts).map_err(err("decode identifier"))?
    };
    Ok((cmd, Some(ds)))
}

fn dimse_find(host: &str, port: u16, called: &str, calling: &str, q: &StudyQuery) -> Result<Vec<StudyRow>, String> {
    let mut scu = connect(host, port, called, calling, STUDY_ROOT_FIND)?;
    let pc = scu.presentation_contexts().first().ok_or("C-FIND was not accepted")?.clone();
    let ts = TransferSyntaxRegistry.get(&pc.transfer_syntax).ok_or("Unknown transfer syntax")?;
    send_command(&mut scu, pc.id, &command(0x0020, STUDY_ROOT_FIND, 1, true, vec![]), Some((&study_identifier(q), ts)))?;
    let mut rows = Vec::new();
    loop {
        let (cmd, ds) = receive_response(&mut scu, ts)?;
        match status_of(&cmd) {
            Some(0xFF00) | Some(0xFF01) => {
                if let Some(row) = ds.as_ref().and_then(row_from) {
                    rows.push(row);
                }
            }
            Some(0) => break,
            other => {
                let _ = scu.abort();
                return Err(format!("C-FIND failed with status {other:?}"));
            }
        }
        if rows.len() >= 500 {
            break; // a browsing UI does not need more; refine the query instead
        }
    }
    let _ = scu.release();
    Ok(rows)
}

/// A storage SCP for the duration of one C-MOVE. Accepts any storage SOP
/// class in any supported transfer syntax and writes Part 10 files.
fn spawn_store_scp(port: u16, ae_title: String, dest: PathBuf, received: Arc<AtomicUsize>, stop: Arc<AtomicBool>) -> Result<std::thread::JoinHandle<()>, String> {
    let listener = TcpListener::bind(("0.0.0.0", port)).map_err(|e| format!("Could not listen on port {port} for C-MOVE: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    Ok(std::thread::spawn(move || {
        let mut options = ServerAssociationOptions::new().accept_any().ae_title(ae_title).promiscuous(true);
        for ts in TransferSyntaxRegistry.iter() {
            if !ts.is_unsupported() {
                options = options.with_transfer_syntax(ts.uid());
            }
        }
        while !stop.load(Ordering::Relaxed) {
            let stream = match listener.accept() {
                Ok((s, _)) => s,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                Err(_) => break,
            };
            let _ = stream.set_nonblocking(false);
            let Ok(mut assoc) = options.establish(stream) else { continue };
            let mut buffer: Vec<u8> = Vec::new();
            let (mut msg_id, mut sop_class, mut sop_instance) = (1u16, String::new(), String::new());
            while let Ok(pdu) = assoc.receive() {
                match pdu {
                    Pdu::PData { mut data } => {
                        for value in data.iter_mut() {
                            match (value.value_type.clone(), value.is_last) {
                                (PDataValueType::Command, true) => {
                                    let Ok(cmd) = InMemDicomObject::read_dataset_with_ts(&value.data[..], &implicit()) else { continue };
                                    let field = cmd.element(tags::COMMAND_FIELD).ok().and_then(|e| e.to_int::<u16>().ok());
                                    msg_id = cmd.element(tags::MESSAGE_ID).ok().and_then(|e| e.to_int::<u16>().ok()).unwrap_or(1);
                                    if field == Some(0x0030) {
                                        // C-ECHO from the PACS: answer it.
                                        let rsp = InMemDicomObject::command_from_element_iter([
                                            DataElement::new(tags::COMMAND_FIELD, VR::US, dicom_value!(U16, [0x8030])),
                                            DataElement::new(tags::MESSAGE_ID_BEING_RESPONDED_TO, VR::US, dicom_value!(U16, [msg_id])),
                                            DataElement::new(tags::COMMAND_DATA_SET_TYPE, VR::US, dicom_value!(U16, [0x0101])),
                                            DataElement::new(tags::STATUS, VR::US, dicom_value!(U16, [0x0000])),
                                        ]);
                                        let mut out = Vec::new();
                                        let _ = rsp.write_dataset_with_ts(&mut out, &implicit());
                                        let _ = assoc.send(&Pdu::PData { data: vec![PDataValue { presentation_context_id: value.presentation_context_id, value_type: PDataValueType::Command, is_last: true, data: out }] });
                                        continue;
                                    }
                                    sop_class = text(&cmd, tags::AFFECTED_SOP_CLASS_UID).unwrap_or_default();
                                    sop_instance = text(&cmd, tags::AFFECTED_SOP_INSTANCE_UID).unwrap_or_default();
                                    buffer.clear();
                                }
                                (PDataValueType::Data, last) => {
                                    buffer.append(&mut value.data);
                                    if !last {
                                        continue;
                                    }
                                    let ts_uid = assoc
                                        .presentation_contexts()
                                        .iter()
                                        .find(|pc| pc.id == value.presentation_context_id)
                                        .map(|pc| pc.transfer_syntax.clone())
                                        .unwrap_or_default();
                                    let status = store_instance(&buffer, &ts_uid, &sop_class, &sop_instance, &dest);
                                    if status == 0 {
                                        received.fetch_add(1, Ordering::Relaxed);
                                    }
                                    let rsp = InMemDicomObject::command_from_element_iter([
                                        DataElement::new(tags::AFFECTED_SOP_CLASS_UID, VR::UI, PrimitiveValue::from(sop_class.as_str())),
                                        DataElement::new(tags::COMMAND_FIELD, VR::US, dicom_value!(U16, [0x8001])),
                                        DataElement::new(tags::MESSAGE_ID_BEING_RESPONDED_TO, VR::US, dicom_value!(U16, [msg_id])),
                                        DataElement::new(tags::COMMAND_DATA_SET_TYPE, VR::US, dicom_value!(U16, [0x0101])),
                                        DataElement::new(tags::STATUS, VR::US, dicom_value!(U16, [status])),
                                        DataElement::new(tags::AFFECTED_SOP_INSTANCE_UID, VR::UI, PrimitiveValue::from(sop_instance.as_str())),
                                    ]);
                                    let mut out = Vec::new();
                                    let _ = rsp.write_dataset_with_ts(&mut out, &implicit());
                                    let _ = assoc.send(&Pdu::PData { data: vec![PDataValue { presentation_context_id: value.presentation_context_id, value_type: PDataValueType::Command, is_last: true, data: out }] });
                                    buffer.clear();
                                }
                                _ => {}
                            }
                        }
                    }
                    Pdu::ReleaseRQ => {
                        let _ = assoc.send(&Pdu::ReleaseRP);
                        break;
                    }
                    Pdu::AbortRQ { .. } => break,
                    _ => {}
                }
            }
        }
    }))
}

/// Write one received instance; returns the C-STORE status.
fn store_instance(data: &[u8], ts_uid: &str, sop_class: &str, sop_instance: &str, dest: &Path) -> u16 {
    let ts_uid = ts_uid.trim_end_matches('\0');
    let Some(ts) = TransferSyntaxRegistry.get(ts_uid) else { return 0xA900 };
    let Ok(obj) = InMemDicomObject::read_dataset_with_ts(data, ts) else { return 0xC000 };
    let safe: String = sop_instance.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
    if safe.is_empty() {
        return 0xC000;
    }
    let Ok(meta) = FileMetaTableBuilder::new()
        .media_storage_sop_class_uid(sop_class)
        .media_storage_sop_instance_uid(sop_instance)
        .transfer_syntax(ts_uid)
        .build()
    else {
        return 0xC000;
    };
    match obj.with_exact_meta(meta).write_to_file(dest.join(format!("{safe}.dcm"))) {
        Ok(()) => 0x0000,
        Err(_) => 0xA700,
    }
}

fn dimse_move(host: &str, port: u16, called: &str, calling: &str, local_port: u16, study_uid: &str, dest: &Path, on_progress: &dyn Fn(usize, Option<usize>)) -> Result<usize, String> {
    let received = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let scp = spawn_store_scp(local_port, calling.to_string(), dest.to_path_buf(), received.clone(), stop.clone())?;
    let result = (|| -> Result<usize, String> {
        let mut scu = connect(host, port, called, calling, STUDY_ROOT_MOVE)?;
        let pc = scu.presentation_contexts().first().ok_or("C-MOVE was not accepted")?.clone();
        let ts = TransferSyntaxRegistry.get(&pc.transfer_syntax).ok_or("Unknown transfer syntax")?;
        let identifier = InMemDicomObject::from_element_iter([
            DataElement::new(tags::QUERY_RETRIEVE_LEVEL, VR::CS, PrimitiveValue::from("STUDY")),
            DataElement::new(tags::STUDY_INSTANCE_UID, VR::UI, PrimitiveValue::from(study_uid)),
        ]);
        let cmd = command(0x0021, STUDY_ROOT_MOVE, 1, true, vec![DataElement::new(tags::MOVE_DESTINATION, VR::AE, PrimitiveValue::from(calling))]);
        send_command(&mut scu, pc.id, &cmd, Some((&identifier, ts)))?;
        loop {
            let (rsp, _) = receive_response(&mut scu, ts)?;
            let num = |tag| rsp.element(tag).ok().and_then(|e| e.to_int::<u32>().ok()).map(|v| v as usize);
            let remaining = num(tags::NUMBER_OF_REMAINING_SUBOPERATIONS);
            let done = received.load(Ordering::Relaxed);
            on_progress(done, remaining.map(|r| r + done));
            match status_of(&rsp) {
                Some(0xFF00) => continue,
                Some(0) => break,
                Some(0xB000) => break, // some sub-operations failed; keep what arrived
                Some(0xA801) => return Err(format!("The PACS does not know the destination AE '{calling}'. Add it (with this computer's address and port {local_port}) on the PACS.")),
                other => return Err(format!("C-MOVE failed with status {other:?}")),
            }
        }
        let _ = scu.release();
        // Let the last C-STORE land.
        std::thread::sleep(Duration::from_millis(200));
        Ok(received.load(Ordering::Relaxed))
    })();
    stop.store(true, Ordering::Relaxed);
    let _ = scp.join();
    result
}

// ─────────────────────────── C-STORE (send) ───────────────────────────

const UNCOMPRESSED: [&str; 2] = ["1.2.840.10008.1.2.1", "1.2.840.10008.1.2"];
/// Native pixel data we can always re-encode into an UNCOMPRESSED syntax
/// (deflate and big endian are wrappers many PACS do not accept).
const REENCODABLE: [&str; 4] = ["1.2.840.10008.1.2.1", "1.2.840.10008.1.2", "1.2.840.10008.1.2.1.99", "1.2.840.10008.1.2.2"];

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendSummary {
    pub sent: usize,
    pub failed: usize,
    /// First few problems, for the reader (not every instance).
    pub errors: Vec<String>,
}

impl SendSummary {
    fn fail(&mut self, msg: String) {
        self.failed += 1;
        if self.errors.len() < 5 {
            self.errors.push(msg);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SendProgress {
    sent: usize,
    total: usize,
}

/// SOP Class and Transfer Syntax from a file's meta header (reads ~1 KB).
fn file_meta(path: &Path) -> Option<(String, String)> {
    let mut f = std::io::BufReader::new(std::fs::File::open(path).ok()?);
    let mut preamble = [0u8; 128];
    f.read_exact(&mut preamble).ok()?;
    let meta = dicom_object::meta::FileMetaTable::from_reader(f).ok()?;
    let clean = |s: &str| s.trim_end_matches(|c: char| c == '\0' || c.is_whitespace()).to_string();
    Some((clean(meta.media_storage_sop_class_uid()), clean(meta.transfer_syntax())))
}

/// Presentation contexts to propose. The acceptor picks ONE transfer syntax per
/// context, so each compressed syntax a file uses gets its own context (sent
/// as-is, never transcoded), plus one uncompressed context per SOP class that
/// native files (incl. deflated / big endian) are re-encoded into, losslessly.
fn store_contexts(metas: &[Option<(String, String)>]) -> Vec<(String, Vec<String>)> {
    let mut by_class: std::collections::BTreeMap<String, std::collections::BTreeSet<String>> = std::collections::BTreeMap::new();
    for (class, ts) in metas.iter().flatten() {
        by_class.entry(class.clone()).or_default().insert(ts.clone());
    }
    let mut out = Vec::new();
    for (class, syntaxes) in by_class {
        for ts in syntaxes.iter().filter(|t| !REENCODABLE.contains(&t.as_str())) {
            out.push((class.clone(), vec![ts.clone()]));
        }
        out.push((class, UNCOMPRESSED.iter().map(|t| t.to_string()).collect()));
    }
    out
}

fn dimse_store(host: &str, port: u16, called: &str, calling: &str, files: &[PathBuf], on_progress: &dyn Fn(usize, usize)) -> Result<SendSummary, String> {
    let metas: Vec<Option<(String, String)>> = files.iter().map(|f| file_meta(f)).collect();
    let contexts = store_contexts(&metas);
    if contexts.is_empty() {
        return Err("None of these files is a DICOM instance that can be sent.".into());
    }
    if contexts.len() > 127 {
        return Err(format!("{} object type / encoding combinations in one send; a DICOM association allows 127.", contexts.len()));
    }
    let mut options = ClientAssociationOptions::new()
        .calling_ae_title(calling.to_string())
        .called_ae_title(called.to_string())
        .connection_timeout(Duration::from_secs(8))
        .read_timeout(Duration::from_secs(60));
    for (class, ts) in &contexts {
        options = options.with_presentation_context(class.clone(), ts.clone());
    }
    let mut scu = options
        .establish_with(&format!("{host}:{port}"))
        .map_err(|e| format!("Could not associate with {called}@{host}:{port}: {e}"))?;
    let accepted: Vec<_> = scu
        .presentation_contexts()
        .iter()
        .filter(|pc| pc.reason == dicom_ul::pdu::PresentationContextResultReason::Acceptance)
        .cloned()
        .collect();

    let total = files.len();
    let mut summary = SendSummary::default();
    for (i, (path, meta)) in files.iter().zip(&metas).enumerate() {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let Some((class, file_ts)) = meta else {
            summary.fail(format!("{name}: not a DICOM file"));
            continue;
        };
        // Same transfer syntax if the PACS took it, else re-encode uncompressed data.
        let pc = accepted
            .iter()
            .find(|pc| &pc.abstract_syntax == class && &pc.transfer_syntax == file_ts)
            .or_else(|| {
                REENCODABLE
                    .contains(&file_ts.as_str())
                    .then(|| accepted.iter().find(|pc| &pc.abstract_syntax == class && UNCOMPRESSED.contains(&pc.transfer_syntax.as_str())))
                    .flatten()
            });
        let Some(pc) = pc else {
            summary.fail(format!("{name}: the PACS does not accept this object type ({class}) in transfer syntax {file_ts}"));
            continue;
        };
        let result = (|| -> Result<u16, String> {
            let obj = dicom_object::OpenFileOptions::new().open_file(path).map_err(err("read"))?;
            let sop_instance = text(&obj, tags::SOP_INSTANCE_UID).ok_or("no SOP Instance UID")?;
            let ts = TransferSyntaxRegistry.get(&pc.transfer_syntax).ok_or("unknown transfer syntax")?;
            let mut data = Vec::new();
            obj.write_dataset_with_ts(&mut data, ts).map_err(err("encode"))?;
            let msg_id = (i % 0xFFFF) as u16 + 1;
            let cmd = command(0x0001, class, msg_id, true, vec![DataElement::new(tags::AFFECTED_SOP_INSTANCE_UID, VR::UI, PrimitiveValue::from(sop_instance.as_str()))]);
            send_command(&mut scu, pc.id, &cmd, None)?;
            {
                use std::io::Write;
                let mut w = scu.send_pdata(pc.id);
                w.write_all(&data).map_err(err("send"))?;
                w.finish().map_err(err("send"))?;
            }
            let (rsp, _) = receive_response(&mut scu, ts)?;
            status_of(&rsp).ok_or_else(|| "no status in the response".to_string())
        })();
        match result {
            // 0xB000/0xB007/0xB006: stored with warnings (coercion etc.).
            Ok(0) | Ok(0xB000) | Ok(0xB006) | Ok(0xB007) => summary.sent += 1,
            Ok(status) => summary.fail(format!("{name}: the PACS refused it (status 0x{status:04X})")),
            Err(e) => {
                summary.fail(format!("{name}: {e}"));
                // The association is unusable after a transport error.
                if e.starts_with("send") || e.starts_with("response") {
                    summary.failed += total - i - 1;
                    break;
                }
            }
        }
        on_progress(summary.sent + summary.failed, total);
    }
    let _ = scu.release();
    Ok(summary)
}

// ───────────────────────────── DICOMweb ─────────────────────────────

fn web_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("RadLearnViewer/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}

fn authed(req: reqwest::RequestBuilder, node: &PacsNode) -> reqwest::RequestBuilder {
    match node {
        PacsNode::Dicomweb { token: Some(t), .. } if !t.is_empty() => req.bearer_auth(t),
        PacsNode::Dicomweb { username: Some(u), password, .. } if !u.is_empty() => req.basic_auth(u, password.clone()),
        _ => req,
    }
}

fn json_text(v: &Value, tag: &str) -> Option<String> {
    let value = v.get(tag)?.get("Value")?.get(0)?;
    let s = match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Object(o) => o.get("Alphabetic").and_then(Value::as_str)?.to_string(),
        _ => return None,
    };
    Some(s).filter(|s| !s.is_empty())
}

fn json_all(v: &Value, tag: &str) -> Vec<String> {
    v.get(tag)
        .and_then(|e| e.get("Value"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

async fn web_find(url: &str, node: &PacsNode, q: &StudyQuery) -> Result<Vec<StudyRow>, String> {
    let mut params: Vec<(&str, String)> = vec![
        ("limit", "500".into()),
        ("includefield", "00081030".into()),
        ("includefield", "00080061".into()),
        ("includefield", "00201206".into()),
        ("includefield", "00201208".into()),
        ("includefield", "00100030".into()),
    ];
    if let Some(n) = q.patient_name.as_ref().filter(|s| !s.trim().is_empty()) {
        params.push(("PatientName", if n.contains('*') { n.clone() } else { format!("{}*", n.trim()) }));
        params.push(("fuzzymatching", "true".into()));
    }
    if let Some(v) = q.patient_id.as_ref().filter(|s| !s.is_empty()) { params.push(("PatientID", v.clone())); }
    if let Some(v) = q.study_date.as_ref().filter(|s| !s.is_empty()) { params.push(("StudyDate", v.clone())); }
    if let Some(v) = q.modality.as_ref().filter(|s| !s.is_empty()) { params.push(("ModalitiesInStudy", v.clone())); }
    if let Some(v) = q.accession_number.as_ref().filter(|s| !s.is_empty()) { params.push(("AccessionNumber", v.clone())); }
    let rsp = authed(web_client()?.get(format!("{url}/studies")).query(&params), node)
        .header("Accept", "application/dicom+json")
        .send()
        .await
        .map_err(|e| format!("Could not reach {url}: {e}"))?;
    if rsp.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(vec![]);
    }
    if !rsp.status().is_success() {
        return Err(format!("QIDO-RS returned HTTP {}", rsp.status()));
    }
    let list: Vec<Value> = rsp.json().await.map_err(err("QIDO-RS response"))?;
    Ok(list
        .iter()
        .filter_map(|v| {
            Some(StudyRow {
                study_instance_uid: json_text(v, "0020000D")?,
                patient_name: json_text(v, "00100010"),
                patient_id: json_text(v, "00100020"),
                patient_birth_date: json_text(v, "00100030"),
                study_date: json_text(v, "00080020"),
                study_time: json_text(v, "00080030"),
                study_description: json_text(v, "00081030"),
                accession_number: json_text(v, "00080050"),
                modalities: json_all(v, "00080061"),
                series_count: json_text(v, "00201206").and_then(|s| s.parse().ok()),
                instance_count: json_text(v, "00201208").and_then(|s| s.parse().ok()),
            })
        })
        .collect())
}

/// The first part of a multipart/related body (WADO-RS answers one instance as one part).
fn first_multipart_part(content_type: &str, body: &[u8]) -> Option<Vec<u8>> {
    let boundary = content_type
        .split(';')
        .map(str::trim)
        .find_map(|p| p.strip_prefix("boundary="))?
        .trim_matches('"');
    let delimiter = format!("--{boundary}");
    let find = |hay: &[u8], needle: &[u8], from: usize| hay[from..].windows(needle.len()).position(|w| w == needle).map(|i| i + from);
    let start = find(body, delimiter.as_bytes(), 0)? + delimiter.len();
    let headers_end = find(body, b"\r\n\r\n", start)? + 4;
    let end = find(body, format!("\r\n{delimiter}").as_bytes(), headers_end)?;
    Some(body[headers_end..end].to_vec())
}

async fn web_retrieve(app: &tauri::AppHandle, url: &str, node: &PacsNode, study_uid: &str, dest: &Path) -> Result<usize, String> {
    let client = web_client()?;
    let rsp = authed(client.get(format!("{url}/studies/{study_uid}/instances")), node)
        .header("Accept", "application/dicom+json")
        .send()
        .await
        .map_err(err("QIDO-RS instances"))?;
    if !rsp.status().is_success() {
        return Err(format!("Listing instances returned HTTP {}", rsp.status()));
    }
    let instances: Vec<Value> = rsp.json().await.map_err(err("QIDO-RS instances"))?;
    let targets: Vec<(String, String)> = instances
        .iter()
        .filter_map(|v| Some((json_text(v, "0020000E")?, json_text(v, "00080018")?)))
        .collect();
    let total = targets.len();
    let done = Arc::new(AtomicUsize::new(0));
    let results: Vec<Result<(), String>> = futures_util::stream::iter(targets.into_iter().map(|(series, sop)| {
        let client = client.clone();
        let done = done.clone();
        let app = app.clone();
        let dest = dest.to_path_buf();
        let req = authed(client.get(format!("{url}/studies/{study_uid}/series/{series}/instances/{sop}")), node)
            .header("Accept", "multipart/related; type=\"application/dicom\"; transfer-syntax=*");
        async move {
            let rsp = req.send().await.map_err(err("WADO-RS"))?;
            if !rsp.status().is_success() {
                return Err(format!("WADO-RS returned HTTP {} for {sop}", rsp.status()));
            }
            let ctype = rsp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            let body = rsp.bytes().await.map_err(err("WADO-RS body"))?;
            let part = if ctype.starts_with("multipart/") { first_multipart_part(&ctype, &body).ok_or("Malformed multipart response")? } else { body.to_vec() };
            let safe: String = sop.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
            std::fs::write(dest.join(format!("{safe}.dcm")), part).map_err(err("write"))?;
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = app.emit("pacs-progress", RetrieveProgress { received: n, total: Some(total) });
            Ok(())
        }
    }))
    .buffer_unordered(8)
    .collect()
    .await;
    let failed: Vec<_> = results.into_iter().filter_map(Result::err).collect();
    let got = done.load(Ordering::Relaxed);
    if got == 0 && !failed.is_empty() {
        return Err(failed[0].clone());
    }
    Ok(got)
}

/// Multipart body for STOW-RS: each file is one application/dicom part.
fn stow_body(boundary: &str, parts: &[Vec<u8>]) -> Vec<u8> {
    let mut body = Vec::with_capacity(parts.iter().map(|p| p.len() + 96).sum());
    for part in parts {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/dicom\r\n\r\n").as_bytes());
        body.extend_from_slice(part);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

/// STOW-RS in batches (≤ 32 files or ~48 MB per request).
async fn web_store(app: &tauri::AppHandle, url: &str, node: &PacsNode, files: &[PathBuf]) -> Result<SendSummary, String> {
    let client = web_client()?;
    let boundary = format!("flowrad-{:x}", std::process::id() as u64 ^ 0x5eed_cafe);
    let total = files.len();
    let mut summary = SendSummary::default();
    let mut batch: Vec<(String, Vec<u8>)> = Vec::new();
    let mut size = 0usize;
    let mut i = 0;
    while i <= files.len() {
        let flush = i == files.len() || batch.len() >= 32 || size > 48 * 1024 * 1024;
        if flush && !batch.is_empty() {
            let parts: Vec<Vec<u8>> = batch.iter().map(|(_, b)| b.clone()).collect();
            let n = batch.len();
            let rsp = authed(client.post(format!("{url}/studies")), node)
                .header("Content-Type", format!("multipart/related; type=\"application/dicom\"; boundary={boundary}"))
                .header("Accept", "application/dicom+json")
                .body(stow_body(&boundary, &parts))
                .send()
                .await;
            match rsp {
                Ok(r) if r.status().as_u16() == 200 => summary.sent += n,
                // 202: some stored. The response lists failures; count them as failed.
                Ok(r) if r.status().as_u16() == 202 => {
                    let body: Value = r.json().await.unwrap_or(Value::Null);
                    let failed = body.get("00081198").and_then(|v| v.get("Value")).and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0).min(n);
                    summary.sent += n - failed;
                    for _ in 0..failed {
                        summary.fail("the server refused an instance (STOW-RS 202)".into());
                    }
                }
                Ok(r) => {
                    let status = r.status();
                    for (name, _) in &batch {
                        summary.fail(format!("{name}: HTTP {status}"));
                    }
                }
                Err(e) => return Err(format!("Could not reach {url}: {e}")),
            }
            let _ = app.emit("pacs-send-progress", SendProgress { sent: summary.sent + summary.failed, total });
            batch.clear();
            size = 0;
        }
        if i == files.len() {
            break;
        }
        let path = &files[i];
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match std::fs::read(path) {
            Ok(bytes) if bytes.len() > 132 && &bytes[128..132] == b"DICM" => {
                size += bytes.len();
                batch.push((name, bytes));
            }
            Ok(_) => summary.fail(format!("{name}: not a DICOM Part 10 file")),
            Err(e) => summary.fail(format!("{name}: {e}")),
        }
        i += 1;
    }
    Ok(summary)
}

// ───────────────────────────── commands ─────────────────────────────

#[tauri::command]
pub async fn pacs_echo(node: PacsNode) -> Result<(), String> {
    match node {
        PacsNode::Dimse { host, port, called_ae, calling_ae, .. } => {
            tauri::async_runtime::spawn_blocking(move || dimse_echo(&host, port, &called_ae, &calling_ae))
                .await
                .map_err(|e| e.to_string())?
        }
        PacsNode::Dicomweb { ref url, .. } => {
            let url = url.trim_end_matches('/');
            let rsp = authed(web_client()?.get(format!("{url}/studies")).query(&[("limit", "1")]), &node)
                .header("Accept", "application/dicom+json")
                .send()
                .await
                .map_err(|e| format!("Could not reach {url}: {e}"))?;
            if rsp.status().is_success() { Ok(()) } else { Err(format!("HTTP {}", rsp.status())) }
        }
    }
}

#[tauri::command]
pub async fn pacs_find(node: PacsNode, query: StudyQuery) -> Result<Vec<StudyRow>, String> {
    match node {
        PacsNode::Dimse { host, port, called_ae, calling_ae, .. } => {
            tauri::async_runtime::spawn_blocking(move || dimse_find(&host, port, &called_ae, &calling_ae, &query))
                .await
                .map_err(|e| e.to_string())?
        }
        PacsNode::Dicomweb { ref url, .. } => web_find(url.trim_end_matches('/'), &node, &query).await,
    }
}

/// Retrieve a study into the app cache; returns the folder to open.
#[tauri::command]
pub async fn pacs_retrieve(app: tauri::AppHandle, node: PacsNode, study_uid: String) -> Result<String, String> {
    let safe: String = study_uid.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
    if safe.is_empty() {
        return Err("Invalid Study Instance UID".into());
    }
    let dest = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("pacs").join(&safe);
    std::fs::create_dir_all(&dest).map_err(err("cache folder"))?;
    let got = match node {
        PacsNode::Dimse { ref host, port, ref called_ae, ref calling_ae, local_port } => {
            let (host, called, calling, dest2, app2) = (host.clone(), called_ae.clone(), calling_ae.clone(), dest.clone(), app.clone());
            tauri::async_runtime::spawn_blocking(move || {
                dimse_move(&host, port, &called, &calling, local_port.unwrap_or(11112), &safe, &dest2, &|received, total| {
                    let _ = app2.emit("pacs-progress", RetrieveProgress { received, total });
                })
            })
            .await
            .map_err(|e| e.to_string())??
        }
        PacsNode::Dicomweb { ref url, .. } => web_retrieve(&app, url.trim_end_matches('/'), &node, &study_uid, &dest).await?,
    };
    if got == 0 && std::fs::read_dir(&dest).map(|mut d| d.next().is_none()).unwrap_or(true) {
        return Err("The PACS returned no images for that study.".into());
    }
    Ok(dest.to_string_lossy().into_owned())
}

/// Send files (an open study) to a PACS: C-STORE, or STOW-RS for DICOMweb.
#[tauri::command]
pub async fn pacs_send(app: tauri::AppHandle, node: PacsNode, files: Vec<String>) -> Result<SendSummary, String> {
    let files: Vec<PathBuf> = files.into_iter().map(PathBuf::from).collect();
    if files.is_empty() {
        return Err("Nothing to send.".into());
    }
    match node {
        PacsNode::Dimse { host, port, called_ae, calling_ae, .. } => {
            let app2 = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                dimse_store(&host, port, &called_ae, &calling_ae, &files, &|sent, total| {
                    let _ = app2.emit("pacs-send-progress", SendProgress { sent, total });
                })
            })
            .await
            .map_err(|e| e.to_string())?
        }
        PacsNode::Dicomweb { ref url, .. } => web_store(&app, url.trim_end_matches('/'), &node, &files).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against a live PACS (e.g. Orthanc with AE TESTPACS on 4242 that knows
    /// RADLEARN at 127.0.0.1:11112): RADLEARN_TEST_PACS=localhost:4242 cargo test dimse
    #[test]
    fn dimse_echo_find_move_against_a_live_pacs() {
        let Ok(addr) = std::env::var("RADLEARN_TEST_PACS") else {
            eprintln!("skipped: set RADLEARN_TEST_PACS=host:port");
            return;
        };
        let (host, port) = addr.split_once(':').unwrap();
        let port: u16 = port.parse().unwrap();
        dimse_echo(host, port, "TESTPACS", "RADLEARN").expect("C-ECHO");
        let rows = dimse_find(host, port, "TESTPACS", "RADLEARN", &StudyQuery { patient_name: Some("PHANTOM".into()), ..Default::default() }).expect("C-FIND");
        assert!(!rows.is_empty(), "C-FIND matched no studies");
        let study = rows.iter().max_by_key(|r| r.instance_count.unwrap_or(0)).unwrap();
        let dest = std::env::temp_dir().join(format!("radlearn-move-{}", std::process::id()));
        std::fs::create_dir_all(&dest).unwrap();
        let got = dimse_move(host, port, "TESTPACS", "RADLEARN", 11112, &study.study_instance_uid, &dest, &|_, _| {}).expect("C-MOVE");
        assert_eq!(Some(got as u32), study.instance_count, "every instance arrived");
        let first = std::fs::read_dir(&dest).unwrap().flatten().next().unwrap().path();
        assert!(crate::header::read_header(&first).is_some(), "stored file is readable DICOM");
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn parses_single_part_multipart() {
        let body = b"--abc\r\nContent-Type: application/dicom\r\n\r\nDICMDATA\r\n--abc--\r\n";
        assert_eq!(first_multipart_part("multipart/related; type=\"application/dicom\"; boundary=abc", body).unwrap(), b"DICMDATA");
        assert_eq!(first_multipart_part("multipart/related; boundary=\"abc\"", body).unwrap(), b"DICMDATA");
    }

    #[test]
    fn store_contexts_one_per_compressed_syntax_plus_uncompressed() {
        let ct = "1.2.840.10008.5.1.4.1.1.2".to_string();
        let mr = "1.2.840.10008.5.1.4.1.1.4".to_string();
        let jpeg = "1.2.840.10008.1.2.4.70".to_string();
        let deflate = "1.2.840.10008.1.2.1.99".to_string();
        let metas = vec![Some((ct.clone(), jpeg.clone())), Some((ct.clone(), UNCOMPRESSED[0].into())), Some((mr.clone(), UNCOMPRESSED[1].into())), Some((mr.clone(), deflate)), None];
        let ctx = store_contexts(&metas);
        let plain: Vec<String> = UNCOMPRESSED.iter().map(|t| t.to_string()).collect();
        assert_eq!(ctx, vec![(ct.clone(), vec![jpeg]), (ct, plain.clone()), (mr, plain)]);
    }

    #[test]
    fn stow_body_is_well_formed_multipart() {
        let body = stow_body("b1", &[b"AAA".to_vec(), b"BB".to_vec()]);
        let text = String::from_utf8(body).unwrap();
        assert_eq!(text, "--b1\r\nContent-Type: application/dicom\r\n\r\nAAA\r\n--b1\r\nContent-Type: application/dicom\r\n\r\nBB\r\n--b1--\r\n");
        assert_eq!(first_multipart_part("multipart/related; boundary=b1", text.as_bytes()).unwrap(), b"AAA");
    }

    fn walk_files(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() { out.extend(walk_files(&p)) } else { out.push(p) }
        }
        out
    }

    /// C-STORE round trip against our own storage SCP (no external PACS needed).
    #[test]
    fn c_store_round_trip_through_local_scp() {
        let Ok(root) = std::env::var("RADLEARN_FIXTURES") else { return };
        let src = std::path::Path::new(&root).join("ct-phantom/axial-5mm");
        let mut files: Vec<PathBuf> = std::fs::read_dir(&src).unwrap().flatten().map(|e| e.path()).take(5).collect();
        // Every transfer syntax fixture goes as-is (the SCP accepts them all): no transcoding.
        let ts_files: Vec<PathBuf> = walk_files(&std::path::Path::new(&root).join("ts")).into_iter().filter(|p| file_meta(p).is_some()).collect();
        let expected = files.len() + ts_files.len();
        files.extend(ts_files);
        let dest = std::env::temp_dir().join(format!("flowrad-store-{}", std::process::id()));
        std::fs::create_dir_all(&dest).unwrap();
        let received = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let scp = spawn_store_scp(11199, "FLOWRADTEST".into(), dest.clone(), received.clone(), stop.clone()).unwrap();
        let summary = dimse_store("127.0.0.1", 11199, "FLOWRADTEST", "FLOWRAD", &files, &|_, _| {}).expect("C-STORE");
        std::thread::sleep(Duration::from_millis(200));
        stop.store(true, Ordering::Relaxed);
        let _ = scp.join();
        assert_eq!(summary.sent, expected, "{summary:?}");
        assert_eq!(summary.failed, 0);
        assert_eq!(received.load(Ordering::Relaxed), expected);
        let first = std::fs::read_dir(&dest).unwrap().flatten().next().unwrap().path();
        assert!(crate::header::read_header(&first).is_some());
        let _ = std::fs::remove_dir_all(&dest);
    }

    /// Against a third-party SCP, e.g. dcmtk: storescp -aet TESTPACS +xa 4242
    /// RADLEARN_TEST_STORESCP=localhost:4242 RADLEARN_FIXTURES=… cargo test c_store_to
    #[test]
    fn c_store_to_an_external_scp() {
        let (Ok(addr), Ok(root)) = (std::env::var("RADLEARN_TEST_STORESCP"), std::env::var("RADLEARN_FIXTURES")) else { return };
        let (host, port) = addr.split_once(':').unwrap();
        let only = std::env::var("RADLEARN_TEST_STORE_ONLY").ok();
        let mut files = Vec::new();
        for sub in ["ct-phantom/axial-5mm", "ts", "documents"] {
            files.extend(walk_files(&std::path::Path::new(&root).join(sub)).into_iter().filter(|p| file_meta(p).is_some()));
        }
        if let Some(only) = only {
            files.retain(|p| p.to_string_lossy().contains(&only));
        }
        // dcmtk does not know HTJ2K (2023): skip it there, it is covered by the local SCP test.
        files.retain(|p| file_meta(p).map(|(_, ts)| !ts.starts_with("1.2.840.10008.1.2.4.20")).unwrap_or(false));
        let summary = dimse_store(host, port.parse().unwrap(), "TESTPACS", "FLOWRAD", &files, &|_, _| {}).expect("C-STORE");
        eprintln!("sent {} of {}: {:?}", summary.sent, files.len(), summary.errors);
        assert_eq!(summary.failed, 0, "{summary:?}");
        assert_eq!(summary.sent, files.len());
    }
}
