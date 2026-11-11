// Deterministic, entirely synthetic fixtures. No network, patient files, or TTS.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const STUDY = '1.2.826.0.1.3680043.10.543.100';
export const SERIES_A = `${STUDY}.1`;
export const SERIES_B = `${STUDY}.2`;
const tag = (vr, ...Value) => ({ vr, Value });
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export function syntheticStudy() {
  const files = new Map();
  const make = (series, index, frames = 1, spacing = true) => {
    const sop = `${series}.${index + 1}`;
    const positions = Array.from({ length: frames }, (_, frame) => [0, 0, index * 3 + frame * 1.5]);
    const metadata = {
      '00020010': tag('UI', '1.2.840.10008.1.2.1'),
      '00080016': tag('UI', frames > 1 ? '1.2.840.10008.5.1.4.1.1.2.1' : '1.2.840.10008.5.1.4.1.1.2'),
      '00080018': tag('UI', sop), '00080060': tag('CS', 'CT'),
      '0008103E': tag('LO', series === SERIES_A ? 'Synthetic single frames' : 'Synthetic multiframe'),
      '00100010': tag('PN', { Alphabetic: 'SYNTHETIC^TEST' }), '00100020': tag('LO', 'SYN-0001'),
      '0020000D': tag('UI', STUDY), '0020000E': tag('UI', series),
      '00200011': tag('IS', series === SERIES_A ? 1 : 2), '00200013': tag('IS', index + 1),
      '00200032': tag('DS', ...positions[0]), '00200037': tag('DS', 1, 0, 0, 0, 1, 0),
      '00200052': tag('UI', `${STUDY}.99`), '00180050': tag('DS', 1.5),
      '00280002': tag('US', 1), '00280004': tag('CS', 'MONOCHROME2'),
      '00280010': tag('US', 64), '00280011': tag('US', 64),
      '00280100': tag('US', 16), '00280101': tag('US', 16), '00280102': tag('US', 15), '00280103': tag('US', 1),
      '00281050': tag('DS', 40), '00281051': tag('DS', 400), '00281052': tag('DS', 0), '00281053': tag('DS', 1),
      ...(spacing ? { '00280030': tag('DS', 0.7, 0.9) } : {}),
      ...(frames > 1 ? {
        '00280008': tag('IS', frames),
        '52009229': tag('SQ', { '00289110': tag('SQ', { '00280030': tag('DS', 0.7, 0.9), '00180050': tag('DS', 1.5) }) }),
        '52009230': tag('SQ', ...positions.map(p => ({ '00209113': tag('SQ', { '00200032': tag('DS', ...p) }) }))),
      } : {}),
    };
    const frameFiles = positions.map((_, frame) => {
      const pixels = Buffer.alloc(64 * 64 * 2);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const value = (x - 32) ** 2 + (y - 32) ** 2 < 400 ? 50 + index * 20 + frame * 30 : -900;
        pixels.writeInt16LE(value + ((x + y) % 8), (y * 64 + x) * 2);
      }
      const file = `pixels/${sop}-${frame + 1}.raw`;
      files.set(file, pixels);
      return file;
    });
    return { sopUID: sop, seriesUID: series, frames, positions, metadata, frameFiles };
  };
  // Three single-frame SOPs out of anatomical order, plus an uncalibrated SOP.
  const instances = [make(SERIES_A, 2), make(SERIES_A, 0), make(SERIES_A, 1), make(SERIES_A, 3, 1, false), make(SERIES_B, 0, 4)];
  const manifest = { studyUID: STUDY, seriesUIDs: [SERIES_A, SERIES_B], instances };
  files.set('study.json', json(manifest));
  files.set('dirty-metadata.json', json({ ...instances[0].metadata,
    '00100010': tag('PN', { Alphabetic: 'DOE^JANE' }), '00080050': tag('SH', 'ACC12345') }));
  const sampleRate = 16000, seconds = 4;
  const wav = Buffer.alloc(44 + sampleRate * seconds * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < sampleRate * seconds; i++) {
    const t = i / sampleRate, cue = (t >= 1 && t < 1.1) || (t >= 3 && t < 3.1);
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * (cue ? 880 : 220) * t) * (cue ? 8000 : 500)), 44 + i * 2);
  }
  files.set('narration.wav', wav);
  const snapshot = (sopUID, renderSeq) => ({ studyUID: STUDY, seriesUID: SERIES_A, sopUID, frame: 1,
    viewportId: 'synthetic-primary', layout: 'single', voi: { ww: 400, wc: 40 }, invert: false,
    camera: { zoom: 1, pan: [0, 0], rotation: 0, flipH: false, flipV: false }, orientation: [1, 0, 0, 0, 1, 0], renderSeq });
  files.set('capture-session.json', json({ id: 'synthetic-capture-1', clock: 'monotonic-ms', media: { firstSampleOffsetMs: 0, cueTimesMs: [1000, 3000], phiReview: 'passed-synthetic' },
    journal: [0, 1].flatMap((i) => [
      { seq: i * 2, t: 900 + i * 2000, kind: 'render', snapshot: snapshot(instances[i].sopUID, i + 1), payload: {} },
      { seq: i * 2 + 1, t: 1000 + i * 2000, kind: 'marker', renderSeq: i + 1, payload: { markerId: `marker-${i + 1}` } },
    ]) }));
  files.set('case.json', json({ id: 'case-synthetic-teach', caseId: 'case-synthetic-teach', orgId: 'org_demo',
    title: 'Synthetic teaching study', modality: 'CT', status: 'published', pacsbinBaseUrl: '',
    clinicalHistory: 'Synthetic practice examination.', primaryDiagnosis: 'CANARY_DIAGNOSIS_7f3a',
    studyRefs: [{ studyInstanceUID: STUDY, seriesInstanceUIDs: [SERIES_A, SERIES_B], role: 'current', order: 0 }],
    findings: [0, 1].map(i => ({ id: `synthetic-${i + 1}`, order: i + 1, label: `CANARY_LABEL_${i}_7f3a`,
      description: `CANARY_DESCRIPTION_${i}_7f3a`, teachingPoints: [`CANARY_PEARL_${i}_7f3a`],
      reportGold: `CANARY_REPORT_${i}_7f3a`, reportMustMention: [`CANARY_ANSWER_${i}_7f3a`],
      state: 'synthetic', marker: { x_pct: 0.5, y_pct: 0.5, shape: 'circle' },
      studyInstanceUID: STUDY, seriesInstanceUID: SERIES_A, sopInstanceUID: instances[i].sopUID,
      sliceIndex: i, windowWidth: 400, windowCenter: 40,
    })) }));
  const hashes = Object.fromEntries([...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));
  files.set('sha256.json', json(hashes));
  return files;
}

export async function writeSyntheticStudy(directory) {
  for (const [name, bytes] of syntheticStudy()) {
    const file = resolve(directory, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeSyntheticStudy(resolve(process.argv[2] ?? 'fixtures/synthetic')).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
