import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The store seam grew a `find(filter)` method so list operations stop pulling
// whole collections and filtering in JS — that is what makes the indexes in
// lib/mongo.ts reachable at all.
//
// These tests pin the *semantics* both store implementations must share:
// equality on every provided key, `undefined` keys ignored (so callers can pass
// optional filters straight through), and correct tenant isolation. They run
// against the JSON store in a scratch dir; the Mongo implementation is the same
// filter document, so agreeing on semantics here is what keeps the seam honest.
// ---------------------------------------------------------------------------

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "flowrad-storequery-"));

type CasesModule = typeof import("./cases.ts");
let casesModule: Promise<CasesModule> | null = null;
function store(): Promise<CasesModule> {
  if (!casesModule) casesModule = import("./cases.ts");
  return casesModule;
}

const ORG_A = "org_query_a";
const ORG_B = "org_query_b";

test("find() scopes by org — one tenant never sees another's rows", async () => {
  const cases = await store();
  await cases.createPatient(ORG_A, { displayName: "A-one" });
  await cases.createPatient(ORG_A, { displayName: "A-two" });
  await cases.createPatient(ORG_B, { displayName: "B-one" });

  const a = await cases.listPatients(ORG_A);
  const b = await cases.listPatients(ORG_B);

  assert.deepEqual(
    a.map((p) => p.displayName).sort(),
    ["A-one", "A-two"]
  );
  assert.deepEqual(b.map((p) => p.displayName), ["B-one"]);
});

test("an optional filter key left undefined does not narrow the result", async () => {
  const cases = await store();
  const patient = await cases.createPatient(ORG_A, { displayName: "Chronology" });
  await cases.createStudy(ORG_A, {
    patientId: patient.id,
    studyInstanceUID: "1.2.840.query.test.1",
  });
  await cases.createStudy(ORG_A, {
    patientId: "some-other-patient",
    studyInstanceUID: "1.2.840.query.test.2",
  });

  // listStudies passes `patientId` through as possibly-undefined.
  const all = await cases.listStudies(ORG_A);
  const scoped = await cases.listStudies(ORG_A, patient.id);

  assert.equal(all.length, 2);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].patientId, patient.id);
});

test("compound filters match on every key", async () => {
  const cases = await store();
  const found = await cases.getStudyByUID(ORG_A, "1.2.840.query.test.1");
  assert.ok(found, "study should be found in its own org");

  // Same UID, wrong org: the compound filter must reject it.
  const crossTenant = await cases.getStudyByUID(ORG_B, "1.2.840.query.test.1");
  assert.equal(crossTenant, null);
});

test("a filter that matches nothing returns empty, not everything", async () => {
  const cases = await store();
  const none = await cases.listPatients("org_that_does_not_exist");
  assert.deepEqual(none, []);
});
