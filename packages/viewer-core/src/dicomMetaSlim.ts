// Slim series index: the series-level WADO-RS metadata document, cut down to
// the tags a viewer actually reads.
//
// Cloud Healthcare returns every tag of every instance — ~11 KB each, so an
// 848-slice CT is a 9.5 MB JSON document that sits between the reader and a
// scrollable stack. The Cornerstone wadors metadata provider reads a fixed set
// of tags (pixel, plane, VOI, modality LUT, SOP, series, US/NM/ECG helpers);
// everything else (private groups, dose reports, protocol blocks, vendor
// sequences) is dead weight in the browser. Measured on the phantom: 9.5 MB →
// ~0.9 MB raw, ~60 KB gzip.
//
// The list below is generated from dicom-image-loader 5.0.x
// (`imageLoader/wadors/metaData/*`) plus every tag our own lib reads. Keep it
// a superset: dropping a tag the provider needs silently breaks a module
// (e.g. no 00280030 → no measurements in mm). Patient name / ID / birth date
// (and accession number) are deliberately NOT kept: the viewer never shows them (lib/dicomOverlay.ts
// is an allow-list), so they do not need to reach the browser at all.

export const SLIM_META_VERSION = 1;

export const SLIM_TAGS: ReadonlySet<string> = new Set(
  (
    // File meta / SOP
    "00020010 00080008 00080016 00080018 00080020 00080021 00080022 00080030 00080031 00080032 " +
    "00080060 00080070 00081030 0008103E 00081140 00081150 00081155 00083002 00083010 00080100 00080104 " +
    // Patient (only what SUV / sizing needs)
    "00100040 00101010 00101020 00101030 " +
    // Acquisition
    "00180040 00180050 00180088 00181030 00181242 00181072 00181074 00181075 00181078 00185100 " +
    "00186011 00186012 00186014 00186016 00186018 0018601A 0018601C 0018601E 00186020 00186022 " +
    "00186024 00186026 00186028 0018602A 0018602C 0018602E 00186030 " +
    // Study / series / instance / plane
    "0020000D 0020000E 00200010 00200011 00200012 00200013 00200032 00200037 00200052 00201041 00201209 00209164 " +
    // Image pixel
    "00280002 00280004 00280006 00280008 00280009 00280010 00280011 00280030 00280034 00280051 " +
    "00280100 00280101 00280102 00280103 00280106 00280107 00281050 00281051 00281052 00281053 " +
    "00281054 00281055 00281056 00281101 00281102 00281103 00281201 00281202 00281203 00282110 00282112 00282114 00283010 " +
    // NM / PET / US / ECG / overlays / multiframe functional groups
    "00540016 00540022 00541001 00541102 00541300 00540081 00540400 " +
    "003A0005 003A0010 003A001A 003A0020 003A0200 003A0208 00400006 0040000B 00401001 00402016 00402017 " +
    "00380010 00380011 00380300 00380400 00321032 " +
    "52009229 52009230 54000100 54001004 54001006 54001010 " +
    "60000010 60000011 60000040 60000050 60000100 60000102 60003000 " +
    "19800102 20000101 20240101 20260101 7FE00008 7FE00009 7FE00010"
  )
    .split(/\s+/)
    .filter(Boolean)
);

type Dataset = Record<string, unknown>;

/** Keep only viewer tags. Unknown shapes pass through untouched. */
export function slimDataset(dataset: unknown): unknown {
  if (!dataset || typeof dataset !== "object" || Array.isArray(dataset)) return dataset;
  const out: Dataset = {};
  for (const [tag, value] of Object.entries(dataset as Dataset)) {
    const t = tag.toUpperCase();
    // Overlay planes repeat in groups 6000–601E.
    const overlay = /^60[0-1][0-9A-E]/.test(t) && SLIM_TAGS.has(`6000${t.slice(4)}`);
    if (SLIM_TAGS.has(t) || overlay) out[tag] = value;
  }
  return out;
}

export function slimSeriesMetadata(datasets: unknown): unknown {
  return Array.isArray(datasets) ? datasets.map(slimDataset) : datasets;
}
