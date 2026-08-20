import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deidAllowsPublish, inspectDicomTags } from "./deid.ts";

test("deidAllowsPublish rejects null and failed reports", () => {
  assert.equal(deidAllowsPublish(null), false);
  assert.equal(deidAllowsPublish(undefined), false);
  assert.equal(deidAllowsPublish(inspectDicomTags({ PatientID: "MRN" })), false);
});

test("passing header report is enough to allow publish (OCR not required)", () => {
  const report = inspectDicomTags({ Modality: "CT", SeriesDescription: "Axial" });
  assert.equal(report.pixelOcrScanned, false);
  assert.equal(deidAllowsPublish(report), true);
});

// ---------------------------------------------------------------------------
// Enforcement, not just policy.
//
// The checks above prove the *rule*. These prove the data layer actually
// applies it — the gap that let a case be created already-published, or
// published with no studyRefs at all, or cleared by another tenant's report.
// The store is pointed at a scratch dir so this never touches real data.
// ---------------------------------------------------------------------------

// DATA_DIR must be set before lib/cases.ts is first evaluated (it reads the env
// at module scope), so the store is imported lazily inside the tests rather than
// at the top of the file.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "flowrad-publishgate-"));

type CasesModule = typeof import("./cases.ts");
let casesModule: Promise<CasesModule> | null = null;
function store(): Promise<CasesModule> {
  if (!casesModule) casesModule = import("./cases.ts");
  return casesModule;
}

const ORG = "org_gate_test";
const OTHER_ORG = "org_gate_other";
const UID = "1.2.840.gate.test.study";

function passingReport(studyInstanceUID: string) {
  return {
    ...inspectDicomTags({ Modality: "CT" }),
    studyInstanceUID,
  };
}

test("a case with no studyRefs cannot be published", async () => {
  const cases = await store();
  await assert.rejects(
    () =>
      cases.createCaseForOrg(ORG, {
        title: "No studies declared",
        modality: "CT",
        pacsbinBaseUrl: "/cornerstone",
        status: "published",
      }),
    /declares no studyRefs/
  );
});

test("publishing at CREATE time is gated, not only on transition", async () => {
  const cases = await store();
  await assert.rejects(
    () =>
      cases.createCaseForOrg(ORG, {
        title: "Published straight out of the gate",
        modality: "CT",
        pacsbinBaseUrl: "/cornerstone",
        status: "published",
        studyRefs: [{ studyInstanceUID: UID, role: "current", order: 0 }],
      }),
    /lack a passing de-id report/
  );
});

test("another org's passing report does not clear this org's gate", async () => {
  const cases = await store();
  await cases.upsertDeidReport(OTHER_ORG, passingReport(UID));

  await assert.rejects(
    () =>
      cases.createCaseForOrg(ORG, {
        title: "Borrowing a neighbour's report",
        modality: "CT",
        pacsbinBaseUrl: "/cornerstone",
        status: "published",
        studyRefs: [{ studyInstanceUID: UID, role: "current", order: 0 }],
      }),
    /lack a passing de-id report/
  );
});

test("a passing report in the case's own org lets it publish", async () => {
  const cases = await store();
  await cases.upsertDeidReport(ORG, passingReport(UID));

  const created = await cases.createCaseForOrg(ORG, {
    title: "Properly cleared",
    modality: "CT",
    pacsbinBaseUrl: "/cornerstone",
    status: "published",
    studyRefs: [{ studyInstanceUID: UID, role: "current", order: 0 }],
  });
  assert.equal(created.status, "published");
});

test("draft to published transition is gated too", async () => {
  const cases = await store();
  const draft = await cases.createCaseForOrg(ORG, {
    title: "Draft with an unverified study",
    modality: "CT",
    pacsbinBaseUrl: "/cornerstone",
    status: "draft",
    studyRefs: [
      { studyInstanceUID: "1.2.840.gate.test.unverified", role: "current", order: 0 },
    ],
  });
  assert.equal(draft.status, "draft");

  await assert.rejects(
    () => cases.updateCaseForOrg(ORG, draft.caseId, { status: "published" }),
    /lack a passing de-id report/
  );
});
