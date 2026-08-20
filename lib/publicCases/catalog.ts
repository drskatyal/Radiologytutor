// Curated public teaching cases: real DICOM from TCIA + authored teaching metadata.
// Radiopaedia references are narrative/education links only — Radiopaedia has no
// case-download API (https://radiopaedia.org/developers).

import type { BodySystem, Difficulty, Finding, TargetLevel } from "@/lib/types";

export type PublicCaseSource =
  | {
      kind: "tcia";
      collection: string;
      studyInstanceUID: string;
      seriesInstanceUID: string;
    }
  | {
      /** Study already present in Orthanc (e.g. BBMRI demo upload). */
      kind: "orthanc_existing";
      studyInstanceUID: string;
      seriesInstanceUID: string;
    };

export interface PublicCaseTemplate {
  caseId: string;
  title: string;
  modality: string;
  specialty: string;
  difficulty: Difficulty;
  system: BodySystem;
  tags: string[];
  source: PublicCaseSource;
  clinicalHistory: string;
  technique: string;
  primaryDiagnosis: string;
  differentials?: string[];
  targetLevel: TargetLevel;
  learningObjectives: string[];
  discussion: string;
  references: string[];
  /** Teaching findings with slice indices relative to imported stack (0-based). */
  findings: Omit<Finding, "id">[];
  patientDisplayName: string;
  patientId?: string;
  studyId?: string;
}

/** Slice helpers — mid-stack anchors until an author re-records in Studio. */
function sliceAt(fraction: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round((count - 1) * fraction)));
}

/** Published catalog of importable real-DICOM teaching cases. */
export const PUBLIC_CASE_CATALOG: PublicCaseTemplate[] = [
  {
    caseId: "case-lidc-nodule-search",
    title: "LIDC chest CT — systematic lung nodule search",
    modality: "CT",
    specialty: "Chest",
    difficulty: "intermediate",
    system: "Chest",
    tags: ["LIDC", "lung nodule", "screening", "registrar"],
    source: {
      kind: "tcia",
      collection: "LIDC-IDRI",
      studyInstanceUID: "1.3.6.1.4.1.14519.5.2.1.6279.6001.210460865401632134346677582159",
      seriesInstanceUID: "1.3.6.1.4.1.14519.5.2.1.6279.6001.314917368146772872954571551463",
    },
    patientDisplayName: "LIDC teaching case (de-identified)",
    patientId: "pat_lidc_nodule",
    studyId: "stu_lidc_nodule",
    clinicalHistory:
      "Screening chest CT from the LIDC-IDRI public research collection. No acute symptoms — practise a registrar search pattern for pulmonary nodules.",
    technique: "Diagnostic chest CT (CAP 5 mm, soft kernel) — TCIA LIDC-IDRI.",
    primaryDiagnosis: "Teaching search — characterize nodules if present",
    differentials: ["Benign granuloma", "Primary lung cancer", "Metastasis"],
    targetLevel: "registrar",
    learningObjectives: [
      "Scroll the chest CT in one direction with lung windows before calling a nodule.",
      "Compare nodule density (solid vs ground-glass vs part-solid) and short-axis measure.",
      "Describe a concise reporting line for an incidental nodule.",
    ],
    discussion:
      "Imaging from the NCI LIDC-IDRI collection (CC BY 3.0). Teaching narrative aligns with open Radiopaedia lung nodule articles — Radiopaedia does not provide bulk DICOM export, so pixels are sourced from TCIA.",
    references: [
      "TCIA LIDC-IDRI — https://www.cancerimagingarchive.net/collection/lidc-idri/",
      "Radiopaedia — Pulmonary nodule (https://radiopaedia.org/articles/pulmonary-nodule-1)",
      "Radiopaedia — Fleischner guidelines overview (https://radiopaedia.org/articles/fleischner-society-pulmonary-nodule-recommendations-1)",
    ],
    findings: [
      {
        label: "Lung window — start mid-chest",
        description:
          "Set a narrow lung window (approx. W 1500 / L -600). Begin at the carina and scroll inferiorly through both lungs.",
        teachingPoints: [
          "Name your search pattern before you scroll — upper lobes first or systematic lobe-by-lobe.",
          "Do not chase mediastinum until both lungs are surveyed.",
        ],
        state: " ",
        marker: { x_pct: 0.52, y_pct: 0.42, shape: "circle" },
        order: 1,
        studyInstanceUID: "1.3.6.1.4.1.14519.5.2.1.6279.6001.210460865401632134346677582159",
        seriesInstanceUID: "1.3.6.1.4.1.14519.5.2.1.6279.6001.314917368146772872954571551463",
        sliceIndex: sliceAt(0.35, 65),
        windowWidth: 1500,
        windowCenter: -600,
      },
      {
        label: "Peripheral nodule survey",
        description:
          "On lung windows scrutinise the periphery for round opacities. Compare size on adjacent slices to confirm a true nodule versus vessel on end.",
        teachingPoints: [
          "Scroll through the nodule — if it disappears it may be a vessel.",
          "Note solid vs subsolid density before measuring.",
        ],
        state: " ",
        marker: { x_pct: 0.68, y_pct: 0.55, shape: "circle" },
        order: 2,
        studyInstanceUID: "1.3.6.1.4.1.14519.5.2.1.6279.6001.210460865401632134346677582159",
        seriesInstanceUID: "1.3.6.1.4.1.14519.5.2.1.6279.6001.314917368146772872954571551463",
        sliceIndex: sliceAt(0.5, 65),
        windowWidth: 1500,
        windowCenter: -600,
      },
      {
        label: "Mediastinal window pass",
        description:
          "Switch to mediastinal windows for a quick pass through hila and mediastinum, then return to lung windows for a second peripheral sweep.",
        teachingPoints: [
          "Two-pass reading reduces missed apical or posterior nodules.",
          "Finish with an impression that separates actionable nodules from benign calcified granulomas.",
        ],
        state: " ",
        marker: { x_pct: 0.48, y_pct: 0.38, shape: "circle" },
        order: 3,
        studyInstanceUID: "1.3.6.1.4.1.14519.5.2.1.6279.6001.210460865401632134346677582159",
        seriesInstanceUID: "1.3.6.1.4.1.14519.5.2.1.6279.6001.314917368146772872954571551463",
        sliceIndex: sliceAt(0.65, 65),
        windowWidth: 400,
        windowCenter: 40,
      },
    ],
  },
  {
    caseId: "case-lung-immunotherapy",
    title: "Anti–PD-1 lung CT — response assessment",
    modality: "CT",
    specialty: "Chest",
    difficulty: "advanced",
    system: "Chest",
    tags: ["immunotherapy", "lung cancer", "response", "oncology"],
    source: {
      kind: "tcia",
      collection: "Anti-PD-1_Lung",
      studyInstanceUID: "1.3.6.1.4.1.14519.5.2.1.3098.5025.250976478345829511981090188621",
      seriesInstanceUID: "1.3.6.1.4.1.14519.5.2.1.3098.5025.214939045402002751093056612263",
    },
    patientDisplayName: "Anti–PD-1 lung teaching case (de-identified)",
    patientId: "pat_pd1_lung",
    studyId: "stu_pd1_lung",
    clinicalHistory:
      "Restaging CT during anti–PD-1 therapy for advanced NSCLC (TCIA Anti-PD-1 Lung collection). Assess primary mass and nodal disease.",
    technique: "Contrast-enhanced chest CT — TCIA Anti-PD-1 Lung collection.",
    primaryDiagnosis: "NSCLC on immunotherapy — assess response",
    differentials: ["Pseudoprogression", "Superimposed infection", "New metastatic site"],
    targetLevel: "registrar",
    learningObjectives: [
      "Measure target lesions with consistent window/level and plane.",
      "Describe immune-related response patterns versus pure progression.",
      "Comment on new nodes or pleural disease in structured report language.",
    ],
    discussion:
      "De-identified research CT from the TCIA Anti-PD-1 Lung collection. Teaching points reference Radiopaedia articles on immunotherapy response — narrative only; DICOM retrieved via TCIA NBIA API.",
    references: [
      "TCIA Anti-PD-1 Lung — https://www.cancerimagingarchive.net/collection/anti-pd-1_lung/",
      "Radiopaedia — Immunotherapy related pneumonitis (https://radiopaedia.org/articles/immune-checkpoint-inhibitor-pneumonitis)",
    ],
    findings: [
      {
        label: "Primary mass survey",
        description:
          "Identify the dominant pulmonary mass on lung windows. Measure long and short axis on the same slice.",
        teachingPoints: [
          "Use lung windows for parenchymal disease; mediastinal windows for nodal stations.",
          "Record whether the mass is cavitating or has surrounding ground-glass.",
        ],
        state: " ",
        marker: { x_pct: 0.58, y_pct: 0.48, shape: "circle" },
        order: 1,
        studyInstanceUID: "1.3.6.1.4.1.14519.5.2.1.3098.5025.250976478345829511981090188621",
        seriesInstanceUID: "1.3.6.1.4.1.14519.5.2.1.3098.5025.214939045402002751093056612263",
        sliceIndex: sliceAt(0.4, 30),
        windowWidth: 1500,
        windowCenter: -600,
      },
      {
        label: "Mediastinal nodes",
        description:
          "On mediastinal windows follow enlarged nodes at stations 4R and 7. Compare to prior if available.",
        teachingPoints: [
          "Short-axis ≥10 mm is suspicious in many protocols — know your local RECIST variant.",
          "Do not confuse unopacified vessels with nodes.",
        ],
        state: " ",
        marker: { x_pct: 0.46, y_pct: 0.36, shape: "circle" },
        order: 2,
        studyInstanceUID: "1.3.6.1.4.1.14519.5.2.1.3098.5025.250976478345829511981090188621",
        seriesInstanceUID: "1.3.6.1.4.1.14519.5.2.1.3098.5025.214939045402002751093056612263",
        sliceIndex: sliceAt(0.55, 30),
        windowWidth: 400,
        windowCenter: 40,
      },
      {
        label: "Pleura and bases",
        description:
          "Finish at the bases and pleural surfaces for effusion, thickening, or new nodules suggesting progression.",
        teachingPoints: [
          "Pseudoprogression can enlarge lesions early — correlate with clinical status.",
          "Always compare both lungs on the same slice before signing.",
        ],
        state: " ",
        marker: { x_pct: 0.62, y_pct: 0.72, shape: "circle" },
        order: 3,
        studyInstanceUID: "1.3.6.1.4.1.14519.5.2.1.3098.5025.250976478345829511981090188621",
        seriesInstanceUID: "1.3.6.1.4.1.14519.5.2.1.3098.5025.214939045402002751093056612263",
        sliceIndex: sliceAt(0.75, 30),
        windowWidth: 1500,
        windowCenter: -600,
      },
    ],
  },
  {
    caseId: "case-neuro-memprage",
    title: "UPENN GBM — FLAIR mass and edema",
    modality: "MR",
    specialty: "Neuroradiology",
    difficulty: "intermediate",
    system: "Neuro",
    tags: ["gbm", "brain tumor", "FLAIR", "registrar"],
    source: {
      kind: "tcia",
      collection: "UPENN-GBM",
      studyInstanceUID: "1.3.6.1.4.1.14519.5.2.1.138726531241229763227804815277949734193",
      seriesInstanceUID: "1.3.6.1.4.1.14519.5.2.1.213489969571616871626069982274524513135",
    },
    patientDisplayName: "UPENN-GBM teaching case (de-identified)",
    patientId: "pat_neuro_bbmri",
    studyId: "stu_neuro_bbmri",
    clinicalHistory:
      "Known glioblastoma — restaging MR from the UPENN-GBM public research collection. Assess enhancing mass, edema, and mass effect.",
    technique: "Axial T2 FLAIR (UPENN-GBM, TCIA).",
    primaryDiagnosis: "Glioblastoma — assess mass effect and vasogenic edema",
    differentials: ["Primary CNS lymphoma", "Metastasis", "Radiation necrosis"],
    targetLevel: "registrar",
    learningObjectives: [
      "Identify vasogenic edema on FLAIR and relate it to mass effect.",
      "Comment on midline shift and ventricular effacement.",
      "Describe enhancement pattern on corresponding post-contrast series if available.",
    ],
    discussion:
      "Real de-identified DICOM from the TCIA UPENN-GBM collection. Teaching narrative references Radiopaedia glioblastoma articles — Radiopaedia does not provide bulk DICOM download.",
    references: [
      "TCIA UPENN-GBM — https://www.cancerimagingarchive.net/collection/upenn-gbm/",
      "Radiopaedia — Glioblastoma (https://radiopaedia.org/articles/glioblastoma-id-1)",
    ],
    findings: [
      {
        label: "FLAIR hyperintensity — vasogenic edema",
        description:
          "Vasogenic edema surrounds the mass as hyperintense signal on FLAIR, finger-like in the white matter.",
        teachingPoints: [
          "Differentiate vasogenic edema from cytotoxic edema (restricted diffusion).",
          "Trace edema to estimate mass effect before measuring shift.",
        ],
        state: " ",
        marker: { x_pct: 0.52, y_pct: 0.45, shape: "circle" },
        order: 1,
        studyInstanceUID: "1.3.6.1.4.1.14519.5.2.1.138726531241229763227804815277949734193",
        seriesInstanceUID: "1.3.6.1.4.1.14519.5.2.1.213489969571616871626069982274524513135",
        sliceIndex: sliceAt(0.35, 25),
      },
      {
        label: "Mass core",
        description:
          "The enhancing tumor core (correlate with T1 post if available) often sits centrally within the edema.",
        teachingPoints: [
          "Report size in three planes when measurable.",
          "Note necrosis or hemorrhage if visible on SWI/GRE.",
        ],
        state: " ",
        marker: { x_pct: 0.48, y_pct: 0.42, shape: "circle" },
        order: 2,
        studyInstanceUID: "1.3.6.1.4.1.14519.5.2.1.138726531241229763227804815277949734193",
        seriesInstanceUID: "1.3.6.1.4.1.14519.5.2.1.213489969571616871626069982274524513135",
        sliceIndex: sliceAt(0.5, 25),
      },
      {
        label: "Midline shift",
        description:
          "Measure septum pellucidum deviation from midline on the slice of maximal shift.",
        teachingPoints: [
          "Shift >5 mm often warrants urgent clinical correlation.",
          "Always state direction of shift (left vs right).",
        ],
        state: " ",
        marker: { x_pct: 0.5, y_pct: 0.35, shape: "arrow" },
        order: 3,
        studyInstanceUID: "1.3.6.1.4.1.14519.5.2.1.138726531241229763227804815277949734193",
        seriesInstanceUID: "1.3.6.1.4.1.14519.5.2.1.213489969571616871626069982274524513135",
        sliceIndex: sliceAt(0.55, 25),
      },
    ],
  },
];

export function getPublicCaseTemplate(caseId: string): PublicCaseTemplate | undefined {
  return PUBLIC_CASE_CATALOG.find((c) => c.caseId === caseId);
}

export function listPublicCaseTemplates(): PublicCaseTemplate[] {
  return PUBLIC_CASE_CATALOG;
}
