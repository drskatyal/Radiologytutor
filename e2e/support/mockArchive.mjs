// A stand-in Orthanc for the archive-backed e2e (playwright.archive.config.ts,
// e2e/archive/case-viewer.spec.ts).
//
// The real app talks to Orthanc two ways, and both are served here:
//   REST      POST /tools/find, GET /studies/{id}, GET /series/{id}
//             (lib/orthanc.ts: resolveCaseSeries lists a case's series)
//   DICOMweb  /dicom-web/...  → scripts/bench/mockDicomweb.mjs, the synthetic
//             WADO-RS/QIDO-RS origin the viewer benchmark already uses, so the
//             real progressiveStack + Cornerstone wadors loaders run unmodified.
//
// Before listening it seeds a JSON data dir (the committed /seed plus one
// published archive case, `case-e2e-archive`, pointing at the mock series),
// so the app server can start with DATA_DIR on it. Test-only; never shipped.
//
//   node e2e/support/mockArchive.mjs            (port MOCK_ARCHIVE_PORT, default 3199)

import { createServer } from "node:http";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { SERIES_UID, STUDY_UID, sopFor, startMockDicomweb } from "../../scripts/bench/mockDicomweb.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.MOCK_ARCHIVE_PORT ?? 3199);
export const MOCK_ARCHIVE_DATA_DIR = process.env.MOCK_ARCHIVE_DATA_DIR ?? join(tmpdir(), "flowrad-e2e-archive-data");
const SLICES = 60;
const STUDY_ID = "e2e-study";
const SERIES_ID = "e2e-series";

async function seedData() {
  await rm(MOCK_ARCHIVE_DATA_DIR, { recursive: true, force: true });
  await mkdir(MOCK_ARCHIVE_DATA_DIR, { recursive: true });
  await cp(join(ROOT, "seed"), MOCK_ARCHIVE_DATA_DIR, { recursive: true });
  const base = JSON.parse(await readFile(join(ROOT, "seed", "case-lidc-nodule-search.json"), "utf8"));
  const archiveCase = {
    ...base,
    id: "case-e2e-archive",
    caseId: "case-e2e-archive",
    title: "E2E archive CT",
    findings: [],
    studyRefs: [{ studyInstanceUID: STUDY_UID, seriesInstanceUIDs: [SERIES_UID], role: "current", order: 0 }],
  };
  delete archiveCase.liveTeachingPack;
  await writeFile(join(MOCK_ARCHIVE_DATA_DIR, "case-e2e-archive.json"), JSON.stringify(archiveCase, null, 2));
  // A teaching case on the same series: two authored findings (slice, window,
  // marker) for the student session's tour (e2e/archive/student-session.spec.ts).
  const finding = (order, sliceIndex, windowWidth, windowCenter, x, y) => ({
    id: `f_e2e_${order}`,
    order,
    label: `E2E finding ${order}`,
    description: `Synthetic finding ${order}.`,
    teachingPoints: [],
    state: "",
    studyInstanceUID: STUDY_UID,
    seriesInstanceUID: SERIES_UID,
    sliceIndex,
    windowWidth,
    windowCenter,
    marker: { x_pct: x, y_pct: y, shape: "circle" },
  });
  await writeFile(
    join(MOCK_ARCHIVE_DATA_DIR, "case-e2e-teach.json"),
    JSON.stringify(
      {
        ...archiveCase,
        id: "case-e2e-teach",
        caseId: "case-e2e-teach",
        title: "E2E teaching CT",
        findings: [finding(1, 14, 1500, -600, 0.3, 0.4), finding(2, 44, 400, 40, 0.62, 0.55)],
      },
      null,
      2
    )
  );
  // The org owns the study: lib/studyAccess gates every pixel read on that.
  await writeFile(
    join(MOCK_ARCHIVE_DATA_DIR, "studies", "stu_e2e_archive.json"),
    JSON.stringify(
      {
        id: "stu_e2e_archive",
        orgId: base.orgId,
        patientId: base.patientId,
        studyInstanceUID: STUDY_UID,
        studyDate: "20250101",
        modality: "CT",
        description: "E2E synthetic CT",
        seriesInstanceUIDs: [SERIES_UID],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      null,
      2
    )
  );
}

function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function main() {
  await seedData();
  const dicomweb = await startMockDicomweb({ slices: SLICES, rows: 256, columns: 256, latencyMs: 0, metadataBuildMs: 0 });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (path === "/" || path === "/health") return json(res, { ok: true, dataDir: MOCK_ARCHIVE_DATA_DIR });
      if (req.method === "POST" && path === "/tools/find") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { Level, Query } = JSON.parse(body || "{}");
        if (Level === "Study") return json(res, Query?.StudyInstanceUID === STUDY_UID ? [STUDY_ID] : []);
        if (Level === "Series") return json(res, Query?.SeriesInstanceUID === SERIES_UID ? [SERIES_ID] : []);
        return json(res, []);
      }
      if (path === `/studies/${STUDY_ID}`) {
        return json(res, { ID: STUDY_ID, Series: [SERIES_ID], MainDicomTags: { StudyInstanceUID: STUDY_UID } });
      }
      if (path === `/series/${SERIES_ID}`) {
        return json(res, {
          ID: SERIES_ID,
          ParentStudy: STUDY_ID,
          MainDicomTags: { SeriesInstanceUID: SERIES_UID, Modality: "CT", SeriesDescription: "BENCH SERIES", SeriesNumber: "1" },
          Instances: Array.from({ length: SLICES }, (_, i) => `e2e-instance-${i}`),
        });
      }
      if (path.startsWith("/dicom-web/")) {
        const upstream = await fetch(`${dicomweb.origin}/dicomweb/${path.slice("/dicom-web/".length)}${url.search}`, {
          headers: { accept: req.headers.accept ?? "*/*" },
        });
        const headers = {};
        for (const name of ["content-type", "cache-control"]) {
          const value = upstream.headers.get(name);
          if (value) headers[name] = value;
        }
        res.writeHead(upstream.status, headers);
        res.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      res.writeHead(404).end("not found");
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  console.log(`mock archive on http://127.0.0.1:${PORT} (data ${MOCK_ARCHIVE_DATA_DIR}, first SOP ${sopFor(0)})`);
}

await main();
