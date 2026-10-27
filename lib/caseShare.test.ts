import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeShare,
  caseHasTeachingPack,
  caseOpenMode,
  caseTeachHref,
  caseViewHref,
  generateShareToken,
  isShareToken,
  lockerActions,
  shareCookieOptions,
  shareGrantsStudy,
  sharePath,
  studyUidsForCase,
  tokenFromSharePath,
  viewerChrome,
  SHARE_COOKIE,
  SHARE_COOKIE_MAX_AGE_SEC,
} from "./caseShare.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "flowrad-caseshare-"));
delete process.env.MONGODB_URI;

test("share tokens are unguessable and url-safe", () => {
  const a = generateShareToken();
  const b = generateShareToken();
  assert.equal(a.length, 43);
  assert.equal(isShareToken(a), true);
  assert.notEqual(a, b);
  assert.equal(sharePath(a), `/s/${a}`);
  assert.equal(tokenFromSharePath(`/s/${a}`), a);
  assert.equal(tokenFromSharePath(`/s/${encodeURIComponent(a)}`), a);
  assert.equal(tokenFromSharePath("/s/short"), null);
  assert.equal(tokenFromSharePath("/s/../admin"), null);
  assert.equal(tokenFromSharePath("/library"), null);
  assert.equal(isShareToken("a".repeat(42)), false);
  assert.equal(isShareToken(`${a}.`), false);
});

test("case open mode keeps teach as the default", () => {
  assert.equal(caseOpenMode(undefined), "teach");
  assert.equal(caseOpenMode(""), "teach");
  assert.equal(caseOpenMode("guided"), "teach");
  assert.equal(caseOpenMode("teach"), "teach");
  assert.equal(caseOpenMode("exam"), "exam");
  assert.equal(caseOpenMode("VIVA"), "exam");
  assert.equal(caseOpenMode("view"), "view");
  assert.equal(caseOpenMode("viewer"), "view");
  assert.equal(caseViewHref("case a"), "/case/case%20a?mode=view");
  assert.equal(caseTeachHref("case-1"), "/case/case-1?mode=teach");
});

test("locker and share chrome keep teach off the shared link", () => {
  assert.deepEqual(lockerActions({ hasPack: true, canManageShare: true }), {
    view: true,
    teach: true,
    share: true,
  });
  assert.deepEqual(lockerActions({ hasPack: false, canManageShare: false }), {
    view: true,
    teach: false,
    share: false,
  });
  assert.deepEqual(
    viewerChrome({ hasPack: true, canManageShare: true, sharedLink: true }),
    { showTeach: false, showShare: false }
  );
  assert.deepEqual(
    viewerChrome({ hasPack: true, canManageShare: true, sharedLink: false }),
    { showTeach: true, showShare: true }
  );
  assert.equal(caseHasTeachingPack({ liveTeachingPack: { findings: [{}] } }), true);
  assert.equal(caseHasTeachingPack({ liveTeachingPack: { findings: [] } }), false);
  assert.equal(caseHasTeachingPack({}), false);
});

test("a share grants only the studies that case names", () => {
  const uids = studyUidsForCase({
    studyRefs: [{ studyInstanceUID: "1.2.3" }, { studyInstanceUID: "1.2.3" }],
    findings: [{ studyInstanceUID: "1.2.9" }, { studyInstanceUID: "  " }],
  });
  assert.deepEqual(uids, ["1.2.3", "1.2.9"]);
  assert.equal(shareGrantsStudy(uids, "1.2.3"), true);
  assert.equal(shareGrantsStudy(uids, "1.2.9"), true);
  assert.equal(shareGrantsStudy(uids, "9.9.9"), false);
  assert.equal(shareGrantsStudy(uids, ""), false);
});

test("active share ignores revoked tokens and keeps the newest live one", () => {
  const picked = activeShare([
    { id: "old", createdAt: "2026-01-01T00:00:00.000Z", revokedAt: "2026-02-01T00:00:00.000Z" },
    { id: "mid", createdAt: "2026-03-01T00:00:00.000Z" },
    { id: "new", createdAt: "2026-04-01T00:00:00.000Z" },
  ]);
  assert.equal(picked?.id, "new");
  assert.equal(activeShare([{ id: "dead", createdAt: "2026-01-01", revokedAt: "2026-01-02" }]), null);
});

test("share cookie is httpOnly and scoped to the site", () => {
  const options = shareCookieOptions();
  assert.equal(SHARE_COOKIE, "flowrad_share");
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/");
  assert.equal(options.maxAge, SHARE_COOKIE_MAX_AGE_SEC);
});

type CasesModule = typeof import("./cases.ts");
let casesModule: Promise<CasesModule> | null = null;
function store(): Promise<CasesModule> {
  if (!casesModule) casesModule = import("./cases.ts");
  return casesModule;
}

const ORG = "org_share_test";
const OTHER = "org_share_other";
const UID = "1.2.840.share.test.study";
const OTHER_UID = "1.2.840.share.test.other";

test("create is idempotent, rotate kills the old token, delete revokes", async () => {
  const cases = await store();
  const created = await cases.createCaseForOrg(ORG, {
    title: "Locker case",
    modality: "CT",
    pacsbinBaseUrl: "/cornerstone",
    studyRefs: [{ studyInstanceUID: UID, role: "current", order: 0 }],
  });

  const first = await cases.createCaseShare(ORG, created.caseId, "user_teacher");
  assert.equal(isShareToken(first.id), true);
  const again = await cases.createCaseShare(ORG, created.caseId, "user_teacher");
  assert.equal(again.id, first.id);

  const access = await cases.resolveShareAccess(first.id);
  assert.equal(access?.orgId, ORG);
  assert.equal(access?.caseId, created.caseId);
  assert.deepEqual(access?.studyUids, [UID]);
  assert.equal(shareGrantsStudy(access?.studyUids ?? [], OTHER_UID), false);

  assert.equal((await cases.listCaseShares(OTHER, created.caseId)).length, 0);
  assert.equal(await cases.getCaseShare("not-a-token"), null);

  const rotated = await cases.rotateCaseShare(ORG, created.caseId, "user_teacher");
  assert.notEqual(rotated.id, first.id);
  assert.equal(await cases.getCaseShare(first.id), null);
  assert.equal((await cases.getCaseShare(rotated.id))?.caseId, created.caseId);

  const removed = await cases.deleteCaseForOrg(ORG, created.caseId);
  assert.equal(removed, true);
  assert.equal(await cases.getCaseShare(rotated.id), null);
  assert.equal(await cases.resolveShareAccess(rotated.id), null);
});
