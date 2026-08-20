# FlowRad Learn — Engineering & Product Evaluation

**Commit evaluated:** `5ac09ed` ("Add web-sourced teaching cases + catalog screenshots")
**Date:** 2026-08-20
**Method:** clean `npm ci` → `npm test` → `npm run build`, plus a full read of the auth
seam, data layer, API surface, imaging proxy, de-id gate, assessment path, and the
student/author/catalog UI.

> **Status update (2026-08-20, after PRs #8 and #9 merged).** The §7 "Now" batch and
> most of "Next" have since been implemented on this branch — see the *Fixed* markers
> below. The three items still open are the `Collection` query seam (§4), the
> click-the-finding viewer mount (§5.1), and the README rewrite (§6).

---

## 0. Headline

**Build health is excellent. Security posture is not ship-ready.**

| Axis | Grade | Note |
|---|---|---|
| Build & tests | **A** | `next build` clean, 138/138 unit tests pass, zero `any`, zero `console.log`, zero TODOs |
| Code craft & consistency | **A−** | Design system honoured, seams documented, 13 inline styles and all genuinely dynamic |
| Architecture (seams) | **B+** | The seams named in CLAUDE.md exist and are respected; the store seam is under-specified (§4) |
| Security & tenancy | **D** | Unauthenticated LLM, TTS, token-mint, and PHI-proxy endpoints. Details in §2 |
| Compliance (de-id gate) | **C** | The module is honest and well-built; the *gate around it* has four bypasses (§3) |
| Product completeness | **B−** | The flagship differentiator (click-the-finding) is graded against a fake image (§5.1) |
| Docs accuracy | **C** | README describes a product architecture the code abandoned two epics ago (§6) |

The codebase reads like a genuinely well-run project — the discipline in `lib/cases.ts`,
`lib/deid.ts`, and `lib/authRoles.ts` is above the bar for most seed-stage products. The
problems are **not** sloppiness. They are a consistent pattern: **policy is written and
tested as pure functions, but never enforced at the edge.** `lib/accessMatrix.test.ts`
exhaustively asserts which role may do what — and eleven route handlers never ask.

---

## 1. What is genuinely strong

- **The store seam is real.** `JsonCollection` / `MongoCollection` behind one `Collection<T>`
  interface, chosen by `collection()`, lazy-connecting, self-seeding. Flipping `MONGODB_URI`
  really does switch the whole app with no call-site changes. That is rare to get right.
- **`lib/deid.ts` is intellectually honest.** It refuses to claim pixel OCR ran
  (`pixelOcrScanned: false`, with a comment explaining that claiming otherwise "would be
  theater"). Most teams fake this. Keep that instinct.
- **Test discipline on pure logic.** 29 test files covering replay, tweening, VOI transitions,
  window presets, marker derivation, grading, taxonomy, publish gating. The hard-to-reason-about
  viewer math is the best-tested part of the codebase — correct priority.
- **Design system is actually used.** No hand-rolled buttons or cards; `components/ui/` is the
  single source. The reading-room aesthetic (reticle motif, editorial serif, tabular numerics)
  reads as domain-authentic rather than generic SaaS.
- **Two-call voice architecture held.** Transcribe and teach are still separate calls
  (`/api/transcribe` → `/api/tutor`), as CLAUDE.md §2 requires, with the transcript shown
  before the answer. The easy shortcut was not taken.

---

## 2. Critical — unauthenticated edges (ship-blockers)

Excluding `/api/auth/[...all]` (the auth handler itself) and `/api/catalog` (deliberately
public), **eleven route handlers perform no authentication at all.** Ranked by blast radius:

### 2.1 `/api/dicomweb/[...path]` — open PHI read **and write** proxy
`app/api/dicomweb/[...path]/route.ts:89-90` exports both `GET` and `POST` with no session
check. The handler attaches Orthanc's Basic-auth header server-side and forwards anything.

- **Read:** anonymous `GET /api/dicomweb/studies` is QIDO-RS — it enumerates every study on
  the imaging backend, across every tenant, including unpublished and draft cases. Frames
  follow. This is a patient-imaging disclosure path, not a nuisance.
- **Write:** `POST` reaches Orthanc's STOW-RS endpoint, which the DICOMweb plugin enables by
  default. Anonymous callers can store instances **bypassing `orthancIngestInstance` entirely** —
  the single ingest seam that runs the de-id header gate (`lib/orthanc.ts:95-100`). The gate
  is real; the proxy routes around it.
- Also: `ORTHANC_PASSWORD` defaults to `""` (`lib/orthanc.ts:10`), so a misconfigured deploy
  authenticates as `flowrad:` with an empty password.

**Fix:** require a session; scope the path to studies the caller's org actually references;
drop `POST` from the proxy entirely (uploads have their own gated route).

> **Fixed.** The route now requires a session, resolves the path's StudyInstanceUID and
> checks it belongs to the caller's org (memoised, so the per-frame cost stays flat), and
> exports only `GET`/`HEAD` — STOW-RS can no longer be proxied around the de-id gate.

### 2.2 `POST /api/auth/demo` — anyone can mint a platform super-admin
`app/api/auth/demo/route.ts:13`. An empty POST body defaults to `role = "super_admin"`, and
`DEMO_USER_ID` carries `platformRole: "super_admin"` (`lib/cases.ts:1931`) — which
`requireRole()` short-circuits on before any membership check. There is no `NODE_ENV` guard
and no env flag. On the live Railway URL, `curl -X POST https://<app>/api/auth/demo` is a
complete authentication bypass to the highest privilege in the system.

**Fix:** gate on `NODE_ENV !== "production"` **or** an explicit `DEMO_AUTH_ENABLED=1`, and cap
the demo role at `student` unless the flag says otherwise.

> **Fixed.** `demoAuthEnabled()` is off in production unless `DEMO_AUTH_ENABLED=1`, and
> `clampDemoRole()` caps production demos at `student` (`author` opt-in). The sign-in UI
> hides the demo button when the path is disabled.

### 2.3 Hardcoded fallback signing secret
`lib/auth.ts:48-50` falls back to the literal `"dev-only-change-me-flowrad-learn-secret!!"`
when `BETTER_AUTH_SECRET` is unset. That string is in the repo. Anyone who reads it can forge
a demo cookie for any `userId` — including `user_demo` — against any deploy that forgot the env
var. The HMAC construction itself is correct (`timingSafeEqual`, expiry, `httpOnly`); the
fallback undoes it.

**Fix:** throw at boot in production if the secret is unset. A missing secret should crash the
app, not silently downgrade it.

> **Fixed.** The literal fallback is gone in production: a serving process with no
> `BETTER_AUTH_SECRET` throws. The build phase is exempted (`NEXT_PHASE`) so `next build`
> still works on a machine without the secret.

### 2.4 `POST /api/voice/realtime` — open token mint
Mints Gemini Live ephemeral tokens for anyone who asks, with no session and no quota. Direct
billing exposure and a free proxy to the account's Gemini Live capacity.

> **Fixed.** Requires a session, is rate-limited by `middleware.ts`, and the mint call now
> has a 15s deadline with the key moved into the `x-goog-api-key` header.

### 2.5 Unauthenticated, unmetered LLM/TTS endpoints
`/api/tutor`, `/api/transcribe`, `/api/structure-finding`, `/api/structure-session`,
`/api/grade-report`, `/api/tts`, `POST /api/audio`. All hit paid APIs. None checks a session.
There is **no rate limiting anywhere in the repo** — no `middleware.ts`, no limiter, and no
request body size cap (audio arrives as unbounded base64; `/api/tts` accepts unbounded text
and will happily synthesise it).

> **Fixed.** Every one of these now requires a session (`requireAuthorOrg` for the two
> authoring routes), and a new `middleware.ts` applies a per-route fixed-window rate limit
> plus a per-route body-size cap, emitting `RateLimit-*` / `Retry-After` headers.

### 2.6 `/api/tutor` is also a cross-tenant and draft-content read
`app/api/tutor/route.ts:50` calls `getCase(caseId)` — the **legacy unscoped** accessor, not
`getCaseForOrg`. Combined with no authentication, an anonymous caller supplies any `caseId`
from any org, and `formatFindingsContextFromCase` loads the full finding text — label,
description, teaching points, diagnosis — into the prompt, where the model reads it back. The
`/api/cases/[caseId]` route does draft-gating correctly; `/api/tutor` is the hole beside it.

**Fix:** `requireSession()` + `getCaseForOrg(await activeOrgId(), caseId)` + the same
draft check the sibling route already implements.

> **Fixed.** Exactly that, plus the upstream error body is no longer returned to the client.

---

## 3. The de-identification gate has four bypasses

`assertCasePublishable` (`lib/cases.ts:676`) is the right check in the wrong number of places.

1. **Create-time bypass.** It is called only from `updateCaseForOrg` on a draft→published
   *transition*. `createCaseForOrg` accepts `status` in its input and never calls it, so a case
   can be created already-published. The legacy `createCase` hardcodes `status: "published"`
   (`lib/cases.ts:503`).
2. **Empty-refs bypass.** `if (refs.length === 0) return;` (line 678) — a case with no
   `studyRefs` passes unconditionally. "No declared studies" is treated as "nothing to check"
   rather than "cannot verify, refuse."
3. **Seed bypass.** Every case in `seed/` ships `status: "published"` with populated
   `studyRefs`, and there is no `seed/deidReports/` directory. They are written straight to the
   store, so the published corpus has never passed the gate it documents.
4. **Cross-org report.** `getDeidReport(uid)` is keyed on UID only, not org-scoped — an org's
   passing report satisfies another org's publish check.

> **Fixed (1–4).** Zero `studyRefs` is now a publish *failure* rather than a free pass;
> `createCaseForOrg` runs the same gate as the draft→published transition; `getDeidReport`
> is org-scoped. `lib/publishGate.test.ts` now exercises the enforcement path against a
> scratch store, not just the pure rule.
>
> Also fixed here: the TCIA pseudonym allowance introduced by PR #8 applied to **every**
> ingest despite its comment claiming otherwise. It is now opt-in
> (`DeidInspectOptions.allowResearchPseudonyms`), set only by the curated importer, and the
> pattern is a full match so free text starting with a collection name no longer passes.

Separately: **pixel OCR is the real remaining risk.** Burned-in PHI on secondary captures,
ultrasound, and scout images is the single most common leak in teaching collections, and header
scrubbing does nothing for it. `lib/deid.ts` is right to refuse to fake it — but public
publishing should not open until it exists.

---

## 4. Architecture — the `Collection` interface cannot scale

The store seam has exactly four methods: `all / get / put / remove`. There is **no query
surface**. Consequently every list operation loads the entire collection into process memory
and filters in JavaScript — 30 call sites of `*Store.all()` in `lib/cases.ts`, including
`listCatalogCases`, `listCasesForOrg`, `listEnrollmentsForUser`, `listProgressForUser`,
`listMembershipsForUser`, `getUserByEmail`.

`MongoCollection.all()` is literally `coll.find({}).toArray()` (`lib/cases.ts:360-364`).

The consequence: **the 30 carefully-chosen indexes in `lib/mongo.ts` are dead code.** Not one
query can use them, because no query ever filters server-side. Today, with a handful of seed
records, this is invisible. At the "500+ cases" figure CLAUDE.md §4a names, every catalog page
load pulls every case in the database over the wire and discards ~99% of it. `getUserByEmail`
scanning the whole `users` collection is on the login path.

Related, smaller:
- **JSON store lost updates.** `updateFindingScoped` is read-modify-write with no locking, and
  `put` is a non-atomic `fs.writeFile`. Two concurrent finding edits silently lose one; a crash
  mid-write leaves a truncated JSON file that `all()` skips — silent data loss.
- **Unique-index races.** `createEnrollment` / `upsertProgress` check-then-write. Under Mongo
  the unique indexes turn that race into an unhandled 500 rather than a clean conflict.
- **No timeout or retry on Gemini calls** (`lib/gemini.ts:129`). A hung upstream pins a serverless
  invocation until the platform kills it. No backoff on 429/503.
- **API key in the query string.** `?key=${API_KEY}` (`lib/gemini.ts:130`) rather than the
  `x-goog-api-key` header. Query strings land in proxy logs, CDN logs, and error reports.
- **Upstream error text is returned to the client.** `/api/tutor` catches and returns
  `err.message`, which is the raw Gemini error body.

> **Fixed (the last three).** All Gemini traffic goes through one `callGemini()` transport:
> key in the header, a `GEMINI_TIMEOUT_MS` deadline, and bounded retries on 429/5xx only.
> Upstream bodies are logged server-side and never returned. The `Collection` query seam
> and the JSON-store write races remain open.

**Fix:** widen the seam by one method — `find(filter, opts)` — implemented as a Mongo query and
as an in-memory filter for JSON. That single addition makes the existing indexes live and is a
mechanical change at ~30 call sites, all inside one file.

---

## 5. Product

### 5.1 Click-the-finding is graded against a picture of nothing

CLAUDE.md §6 names this as *"the differentiator — it runs ON the viewer we own."* It does not.
`components/catalog/CourseAssessment.tsx:273-278` renders:

```
{/* Atmospheric CT-like plane — marker coords are overlay [0,1]. */}
<div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_45%,#3a3a3a_0%,#111_55%,#000_100%)]" />
```

The learner clicks on a **CSS radial gradient** and is scored against a marker the author placed
on a real DICOM study, via `clickHitsFinding` with an 0.08 hit radius. The grading math is
correct and well tested; the input is meaningless. A student cannot localise a pneumothorax on
a decorative gradient, so the score is noise — and it is presented as an assessment result that
feeds a certificate.

This is the one item in the codebase that meets CLAUDE.md's own "would embarrass us in front of
a radiology department" test. It should either mount `StudentViewer` (all the pieces exist —
`FindingMarker` already does normalized-coordinate overlay on the real viewer) or be hidden
behind a feature flag until it does.

### 5.2 The marketplace has one of everything

`screenshot-library.png` shows the shape of the problem: three rails — Courses, Teachers,
Continue — each rendering exactly **one** ~290px card in a ~1150px content column. The catalog
UI is built for a marketplace and populated like a demo. Symptoms: an inner vertical scrollbar
on a rail holding one item; a "Continue where you left off" playlist card shown to users with
no history; a "Featured teachers" rail with a single teacher.

Rails should collapse to a grid (or hide) below a threshold count, and personalised rails should
render only when there is genuinely something to resume.

### 5.3 Catalog is hardcoded to a single tenant

> **Fixed.** `/api/catalog`, `app/page.tsx` and `app/playlist/[id]/page.tsx` now derive the
> org from `activeOrgId()` — session-derived, never client-supplied. No `DEFAULT_ORG_ID`
> call sites remain outside `lib/`.


`app/api/catalog/route.ts:25` — `const ORG = DEFAULT_ORG_ID;`. Same in `app/page.tsx:44-46` and
`app/playlist/[id]/page.tsx:12`. Public browsing is permanently pinned to `org_demo`, so a
second tenant's published catalog is unreachable through the product's front door. The comments
still say *"until real auth lands (§4a)"* — auth has landed; these are the leftover call sites
CLAUDE.md §6 asks to replace with `activeOrgId()`.

### 5.4 Smaller product notes

- **Dev surfaces in production nav.** The sidebar ships a `DEVELOPER` section with "Record lab"
  and "Viewer lab" (`/record`, `/cornerstone`) to every signed-in user, including students.
- **Catalog is invisible without JS.** Cards render at `initial="hidden"` → `opacity: 0`
  (`components/catalog/CaseCard.tsx:112-125`). The server HTML paints the entire catalog at zero
  opacity until framer-motion hydrates. If hydration is slow or fails the library is blank, and
  LCP is measured on an invisible element.
- **`/api/tts` accepts an arbitrary `voiceId`** from the request body, so any caller can drive
  any voice in the ElevenLabs account, not just the one enrolled for that author.
  **Fixed** — the voice is resolved server-side from an author record in the caller's org;
  a client-supplied `voiceId` is ignored, and `lib/speak.ts` no longer sends one.
- **Seed provenance.** `seed/case-chest-spontaneous-ptx.json` points `pacsbinBaseUrl` at a
  third-party `pacsbin.com` case. For a marketplace that will monetise teaching content, the
  licensing and attribution of web-sourced cases needs to be settled before P3, and it
  contradicts the self-hosted-Cornerstone architecture.

---

## 6. Documentation drift

`README.md` still opens with *"We are **not** building a DICOM viewer. Pacsbin renders the
images"* and documents the bookmark-paste viewport-capture workaround at length. The product
self-hosts Cornerstone3D against Orthanc; `components/CornerstoneViewer.tsx` is 1,173 lines. The
route list omits `/library`, `/studio`, `/dashboard`, `/admin`, `/learning`, `/course`,
`/certificate` — roughly two-thirds of the app. `npm test` is described as *"unit tests for
`lib/pacsbinUrl.ts`"*; it runs 138 tests across 29 files.

CLAUDE.md §4 also names the wrong working branch (`claude/epic-noether-3nvcbf`).

This matters more than it looks: a new contributor reading the README will build against an
architecture the code abandoned.

---

## 7. Recommended sequence

### Now — before any further public exposure
1. **Authenticate `/api/dicomweb`**, scope it to the caller's org, and delete the `POST` export.
2. **Gate `/api/auth/demo`** behind `NODE_ENV`/env flag; cap the default demo role at `student`.
3. **Fail boot in production when `BETTER_AUTH_SECRET` is unset** — remove the literal fallback.
4. **Add `requireSession()` to the seven AI/TTS/token routes**, and swap `/api/tutor` onto
   `getCaseForOrg(activeOrgId(), …)` with the draft check.
5. **Add `middleware.ts`** with a per-session/IP token bucket on the paid routes, plus body-size
   caps (audio, TTS text).

### Next — correctness the product already promises
6. **Close the publish gate:** call `assertCasePublishable` from `createCaseForOrg` too; make
   zero `studyRefs` a *failure*; org-scope `getDeidReport`; add passing reports to `seed/` (or
   ship the seed cases as drafts).
7. **Either wire click-the-finding to `StudentViewer` or flag it off.** Grading against a
   gradient is worse than not shipping the question type.
8. **Replace the four `DEFAULT_ORG_ID` call sites** in the public catalog paths with `activeOrgId()`.

### Then — before the catalog grows
9. **Add `find(filter, opts)` to the `Collection` seam** and move the 30 `all()` filters into it.
   This is what makes `lib/mongo.ts` mean anything.
10. **Timeouts + retry/backoff on Gemini**, key into the header, and stop returning upstream
    error bodies to clients.
11. **Route-level access tests.** `lib/accessMatrix.test.ts` proves the *policy*; add a harness
    that asserts each route *calls* it. Every finding in §2 would have been caught by that test.

### Ongoing
12. Rewrite `README.md` against the Cornerstone/Orthanc architecture; fix the branch name in
    CLAUDE.md §4.
13. Collapse single-item rails; hide dev-lab nav from non-staff; render catalog cards visible-first
    and animate as enhancement.
14. Scope pixel-OCR for burned-in PHI as the gate on public publishing.

---

## 8. One-line summary

A genuinely well-engineered teaching platform with a clean build, honest seams, and strong test
discipline — held back by a consistent gap between policy and enforcement at the HTTP edge, a
data-layer seam that cannot use its own indexes, and one flagship feature grading students
against an image that isn't there.
