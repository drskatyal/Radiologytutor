# FlowRad Learn — Marketplace Architecture & Roadmap

> **Thesis.** FlowRad Learn becomes **the marketplace where radiologists teach radiology** —
> Udemy/Coursera reimagined around the one thing those platforms can't do: an **AI-tutored,
> narrated, interactive DICOM case**. A video course is a flat recording; ours is a *live
> reading-room session* a learner can interrupt by voice, where the viewer drives itself to
> the finding, and where assessment happens *on the pixels* (click the nodule, dictate the
> impression) rather than on a multiple-choice abstraction of them.
>
> This document is the build plan for that transition. It is grounded in the current code
> (`lib/types.ts`, `lib/cases.ts`, `lib/mongo.ts`, `lib/orthanc.ts`, `lib/gemini.ts`,
> `app/`, `components/`) and is **additive** wherever possible: the STORE SEAM, the `orgId`
> scoping, and the viewer-state model all survive untouched.

---

## 0. Honest assessment of what exists (Jun 2026)

**Solid — keep and build on:**

- **Data-layer seam (`lib/cases.ts`).** Every read/write goes through one module behind a
  `Collection<T>` interface with a runtime JSON-vs-Mongo `collection()` factory ("STORE
  SEAM"). New entities are a one-line `collection<T>("name")` + a set of CRUD functions —
  no caller churn. This is the single most valuable asset for the marketplace.
- **Multi-tenancy is pre-wired.** Every entity carries `orgId`; every API takes/derives it;
  `DEFAULT_ORG_ID = "org_demo"` is the *only* stub. Mongo indexes are already `{ orgId, … }`
  compound (`lib/mongo.ts`). Real auth slots into the `orgId`-derivation seam without a
  schema migration.
- **Viewer-state model is stable and decoupled** (`lib/types.ts`): normalized `[0,1]`
  markers, `RecordedTrack` (ordered events + narration audio), DICOM identity as UIDs. This
  is exactly what an *interactive image assessment* needs — we already own the substrate that
  Coursera/Udemy lack.
- **Two-call AI discipline** (`lib/gemini.ts`): transcription and teaching are separate; the
  teaching call already emits **tool calls** (`show_finding`, `set_window`, …) and is
  web-grounded. AI grading of reports is the *same* pattern with a new tool schema.
- **Library entities exist** (`Author`, `Course`, `Playlist`) and a real **catalog** with
  facets/filters (`listCatalogCases`, `getCatalogFacets`) and a polished catalog UI
  (`components/catalog/`). The "library" shell is done; the "marketplace" layer is not.
- **Imaging ingest is a single seam** (`orthancIngestInstance`) with de-id explicitly TODO'd
  in one place — the right shape for compliance enforcement later.

**Missing — the marketplace gaps (in priority order):**

1. **No identity.** `User` is a type with no authentication, no session, no login. `Author`
   is *attribution only* and explicitly decoupled from `User`. There is **one demo org**.
   This is the #1 blocker: "multi-author" is impossible without real accounts + orgs + RBAC.
2. **No author self-service.** `/author` edits cases in the demo org; there is no onboarding,
   verification, profile, or "my studio." An author cannot sign up and publish.
3. **No enrollment / progress / entitlement.** Catalog → case is a direct link; nothing
   records who started/finished what, nothing gates paid content.
4. **No assessment / CME.** No questions, attempts, scores, certificates. The single biggest
   *product* differentiator (image-based questions on the viewer we own) is unbuilt.
5. **No monetization.** No orders, subscriptions, payouts, or revenue share.
6. **De-identification is a TODO**, not enforced. For a *public multi-author* platform this
   becomes a hard publishing gate, not a deferral.
7. **`Author` ≠ `User`.** Today's `Author` is a public face with no owning account. The
   marketplace needs `AuthorProfile` *attached to* an authenticated `User`.

The codebase is a well-built **single-tenant teaching library with a marketplace-shaped data
seam**. The work is to light up identity, then layer enrollment → assessment → money on top
of seams that already exist.

---

## 1. Personas & jobs-to-be-done

| Persona | Who | Core jobs-to-be-done |
|---|---|---|
| **Learner** | Resident, fellow, CME-seeking attending, med student, int'l trainee | "Find cases for my rotation/subspecialty at my level." "Be taught a real study by an expert, hands-on, and ask questions by voice." "Test that I can actually *find* the finding and *dictate* the report." "Earn CME I can submit for credit." "Resume where I left off." |
| **Author / Educator** | Subspecialty radiologist, fellowship PD, society (RSNA/ACR chapter), a department | "Sign up, prove I'm a radiologist, build a credible public profile." "Upload a (de-identified) study, mark findings, record my narration, publish a case/course fast." "Price it, reach learners, get paid, see what's working." "Build a following and reputation." |
| **Org / Institution admin** | Residency program coordinator, hospital education lead | "Buy seats for my 30 residents." "Assign curricula, see who completed what, export for ACGME milestones / CME audit." "Run our *own* private cases for our trainees (tenant isolation)." |
| **Platform admin** | FlowRad staff | "Verify authors and gate publishing." "Moderate content + enforce de-identification." "Run payouts, handle disputes, watch quality (ratings/flags)." "Operate the marketplace." |

The dual nature matters: an **Org** is both a *private tenant* (a hospital teaching its own
trainees on its own cases — today's model) **and** a *seat-buyer on the public marketplace*.
The data model must serve both without a fork.

---

## 2. Domain & data model

### 2.1 Principle: additive, behind the STORE SEAM

Everything below is a **new Mongo collection** added exactly like `authors`/`courses` today —
one `collection<T>(name)` in `lib/cases.ts`, a typed CRUD block, an `ensureIndexes()` line in
`lib/mongo.ts`. **Nothing existing is renamed or removed.** Existing `Case`/`Finding`/`Author`
keep their shape; new fields are optional for back-compat with seed data (the codebase's
established discipline — see `normalizeCase`).

### 2.2 New & extended entities

```
Account/User ──< Membership >── Org ──(public marketplace tenant or private institution)
   │                               │
   └─ AuthorProfile (1:1, verified)│
                                   │
Patient ─< Study ─< Series ──used-by── Case ─< Finding   (UNCHANGED)
                                   │
Course ─< Module ─< Lesson(→Case)  (Course gains structure; Lesson is the new join)
   │
   ├─ Assessment ─< Question ─< (Attempt ─< Response) ── Score
   │      (Question types: click-finding · MCQ · AI-graded report)
   │
Enrollment(user→course) ─< Progress(user→lesson)  ── Certificate (CME)
Review(user→course)   Order/Entitlement(user→product)   Subscription   Payout(author)
Notification   ModerationRecord/VerificationRequest   DeidReport(study)
```

**Identity & tenancy**

- **`User`** *(extend existing)* — add `authProviderId` (subject from the auth provider),
  `image`, `lastSeenAt`. `role` on `User` is deprecated in favor of per-org `Membership.role`
  (a user can be an author in their own org and a learner in their hospital's org).
- **`Membership`** *(new)* — `{ id, userId, orgId, role: 'owner'|'admin'|'author'|'student',
  seatId?, status, invitedBy?, createdAt }`. The RBAC join table. **Authorization = "does
  this user have a membership in this org with a sufficient role?"** All existing
  `orgId`-scoped functions gain their `orgId` from the *session's active membership* instead
  of `DEFAULT_ORG_ID`.
- **`Org`** *(extend)* — add `type: 'individual'|'institution'`, `slug`, `branding` (logo,
  accent), `billingCustomerId` (Stripe customer), `seatCount`. An individual author still gets
  a personal org (so the model never forks).
- **`AuthorProfile`** *(new, replaces "Author is attribution only")* — `{ id, userId, orgId,
  displayName, slug, credentials (e.g. "MD, FRCR"), subspecialties: BodySystem[], institution,
  bio, avatarUrl, bannerUrl, socials, verification: { status: 'unverified'|'pending'|'verified'|'rejected',
  method, verifiedAt, reviewerId }, stats: { followers, courses, avgRating, learners } }`.
  The existing `Author` collection is **migrated into** `AuthorProfile` (same `id` space; add a
  `userId` and `verification` block). `Case.authorId` / `Course.authorId` keep pointing at it —
  zero churn for the catalog/attribution UI.
- **`Follow`** *(new)* — `{ followerUserId, authorProfileId }` for the social graph.

**Learning structure**

- **`Course`** *(extend)* — keep `caseIds` for back-compat but add `modules: Module[]`
  (ordered), `objectives: string[]`, `prerequisites: string[]`, `audienceLevel: Difficulty`,
  `estimatedMinutes`, `price` (see §4), `cmeCredits?`, `language`. A migration reads legacy
  `caseIds` into a single default module so old courses render unchanged.
- **`Module`** *(new, embedded in Course)* — `{ id, title, lessons: Lesson[] }`.
- **`Lesson`** *(new, embedded)* — `{ id, type: 'case'|'reading'|'assessment', caseId?,
  assessmentId?, title }`. A Lesson is the unit a learner completes; a case-lesson points at
  an existing `Case`.

**Engagement & outcomes**

- **`Enrollment`** *(new)* — `{ id, userId, orgId, courseId, source: 'free'|'purchase'|'seat'|'subscription',
  entitlementId?, startedAt, lastLessonId?, completedAt? }`. Resume = `lastLessonId`.
- **`Progress`** *(new)* — `{ id, userId, courseId, lessonId, status: 'started'|'completed',
  score?, viewerCheckpoints?, updatedAt }`. Granular completion + viewer resume position.
- **`Review`** *(new)* — `{ id, userId, courseId, authorProfileId, rating 1–5, body,
  status: 'visible'|'flagged'|'removed', createdAt }`. Feeds `AuthorProfile.stats.avgRating`.

**Assessment & CME** *(the differentiator — see §5)*

- **`Assessment`** *(new)* — `{ id, orgId, courseId?, caseId?, title, passingScore,
  questionIds, cmeEligible }`.
- **`Question`** *(new)* — discriminated union on `kind`:
  - `'click_finding'` — `{ caseId, findingId, prompt, targetMarker: Marker, toleranceRadiusPct }`
    — learner clicks on the **viewer**; graded by distance to the stored normalized marker.
    *This is unique to us — we already store `marker` in `[0,1]` and own the viewer.*
  - `'mcq'` — `{ prompt, options[], correctIndex, rationale }`.
  - `'report'` — `{ caseId, prompt, rubric, modelAnswer }` — learner **dictates/types an
    impression**; graded by Gemini against the rubric (reuses the `reporting` mode +
    `runTeachingPlan` plumbing in `lib/gemini.ts`).
- **`Attempt`** *(new)* — `{ id, userId, assessmentId, responses: Response[], score,
  passed, startedAt, submittedAt }`.
- **`Certificate`** *(new)* — `{ id, userId, courseId, cmeCredits, accreditationStatement,
  serial, issuedAt, pdfUrl }`. Issued on pass when `cmeEligible` + the course is under an
  accredited provider org (see §5 business note).

**Marketplace economics** *(see §4)*

- **`Product`** *(new)* — the sellable unit: `{ id, kind: 'course'|'bundle'|'subscription'|'seatpack',
  refId, price, currency, authorOrgId }`. Decouples pricing from `Course` so bundles/subs reuse it.
- **`Order`** *(new)* — `{ id, userId, orgId, items[], amount, stripePaymentIntentId, status }`.
- **`Entitlement`** *(new)* — `{ id, userId/orgId, productId, source, expiresAt? }`. The **gate**
  the catalog/lesson routes check before serving paid content. Seat-based entitlements are
  org-scoped (every member inherits).
- **`Subscription`** *(new)* — `{ id, orgId/userId, plan, stripeSubscriptionId, status,
  currentPeriodEnd }`.
- **`Payout`** *(new)* — `{ id, authorOrgId, periodStart, periodEnd, grossCents, platformFeeCents,
  netCents, stripeTransferId, status }`. Driven by `Order` line items + revenue share.

**Trust & ops**

- **`Notification`** *(new)* — `{ id, userId, kind, payload, readAt }` (enrollment, new review,
  payout, verification result, content flagged).
- **`ModerationRecord` / `VerificationRequest`** *(new)* — audit trail for author verification
  and content review decisions; referenced by the publish gate (§7).
- **`DeidReport`** *(new)* — per-study `{ studyId, headerScrubbed, pixelOcrScanned, findings:
  PhiHit[], status: 'pass'|'fail'|'manual_override', reviewerId? }`. **Publishing a case is
  blocked unless every referenced study has a passing `DeidReport`** (§7).

### 2.3 Mapping onto the STORE SEAM

Each new collection is registered exactly like the existing ones:

```ts
// lib/cases.ts — same pattern as authorsStore/coursesStore today
const memberships  = collection<Membership>("memberships");
const enrollments  = collection<Enrollment>("enrollments");
const progress     = collection<Progress>("progress");
const assessments  = collection<Assessment>("assessments");
const attempts     = collection<Attempt>("attempts");
const orders       = collection<Order>("orders");
const entitlements = collection<Entitlement>("entitlements");
// …reviews, certificates, payouts, notifications, deidReports, follows
```

…and indexed in `ensureIndexes()`: e.g. `{ userId: 1 }`, `{ orgId: 1, courseId: 1 }` on
enrollments; `{ userId: 1, productId: 1 }` (unique) on entitlements; `{ authorOrgId: 1, status: 1 }`
on payouts. **`orgId` scoping is preserved** on every tenant-owned collection; user-owned
collections (enrollment, progress, attempts) are scoped by `userId` and double-checked against
the active membership. The JSON store keeps working for local/dev (each collection is a subdir),
so `npm test` and offline dev are unaffected.

---

## 3. Identity & access (the foundational P0)

### Recommendation: **Better Auth + Google OAuth**, behind `lib/auth.ts`.

Clerk is **not** the production path (vendor outage risk + cost). Identity is
**Better Auth** (self-hosted sessions on Mongo or memory in dev) with **Google
OAuth** as the preferred sign-in (credentials stay with Google). Email/password
remains available. The seam is non-negotiable: **no `better-auth` import outside
`lib/auth.ts` and `app/api/auth/[...all]`**. Domain RBAC stays in our
`Membership` rows; `activeOrgId()` replaces `DEFAULT_ORG_ID` at call sites.


The 2026 Next.js auth landscape shifted: **Auth.js/NextAuth is effectively in maintenance**
(its lead left; the project folded toward Better Auth), and it ships **no built-in
multi-tenancy, RBAC, or org primitives** — exactly what a marketplace needs — so you'd be
hand-rolling the org/role glue that is our P0.
([Better Auth vs Clerk vs Auth.js 2026](https://www.buildmvpfast.com/blog/better-auth-vs-clerk-vs-authjs-nextjs-decision-tree-2026),
[Clerk: orgs + RBAC in Next.js](https://clerk.com/articles/organizations-and-role-based-access-control-in-nextjs))

**Why Clerk for FlowRad specifically:**

- **Organizations + RBAC are first-class.** Clerk Organizations give hierarchical teams,
  org-switching UI, member management, and up to 10 custom roles out of the box — a near-exact
  fit for our `Org`/`Membership` model and the institution-seats use case, which would
  otherwise take weeks to build.
  ([Clerk orgs/RBAC](https://clerk.com/articles/organizations-and-role-based-access-control-in-nextjs))
- **Time-to-multi-author is the goal.** Hosted sign-up, social/email, prebuilt profile and
  org components let us ship "an author can sign up, get a profile, and publish" in P0 instead
  of building auth UI.
- **Institutional SSO later** (SAML) is a paid add-on, not a re-platform — important because
  hospitals/residencies will demand SSO. (Enterprise SSO is priced per connection on higher
  tiers — a known, bounded cost.)
  ([buildmvpfast comparison](https://www.buildmvpfast.com/blog/better-auth-vs-clerk-vs-authjs-nextjs-decision-tree-2026))

**The seam (non-negotiable).** Mirror the STORE SEAM discipline: **no Clerk import outside
`lib/auth.ts`**. That module exports `getSession()`, `requireUser()`, `requireRole(orgId, role)`,
and `activeOrgId()`. Clerk's `userId`/`orgId` map to our `User.authProviderId` /
`Org.id` (we keep our own `User`/`Org`/`Membership` rows as the source of truth for domain data,
synced via Clerk webhooks). If Clerk's pricing or org-retention limits bite at scale, swapping
to **Better Auth** (now the recommended self-hosted choice for B2B multi-tenant with built-in
teams/roles/SAML/SCIM) touches only `lib/auth.ts`.
([Better Auth for B2B multi-tenant](https://makerkit.dev/blog/tutorials/better-auth-vs-clerk))

### RBAC roles (per-org, via `Membership.role`)

| Role | Can |
|---|---|
| `owner` | Everything in the org + billing + delete org. (Individual author = owner of their personal org.) |
| `admin` | Manage members/seats, assign curricula, view org analytics; not billing-destructive. |
| `author` | Create/edit/publish their own cases & courses; manage their `AuthorProfile`. |
| `student` | Enroll, learn, attempt assessments, earn certificates. |
| Platform admin | A flag/claim on staff users; cross-org verification, moderation, payouts. *Not* an org role. |

### Multi-tenant authorization rule (one sentence to enforce everywhere)

> A request is authorized iff the session user has a `Membership` in the target resource's
> `orgId` whose role meets the action's minimum — checked in `lib/auth.ts`, derived once per
> request, passed as the `orgId` arg into the **existing** `lib/cases.ts` functions.

This means the bulk of the data layer **does not change** — we replace `DEFAULT_ORG_ID` call
sites with `await activeOrgId()` and add a `requireRole()` check at the API boundary. Public
catalog reads stay public (published, marketplace-visible content is cross-org readable).

**Biggest risk:** getting tenancy wrong leaks one author's draft/PHI to another. Mitigation:
a single `assertOrgAccess()` chokepoint, an integration test matrix per role, and keeping the
`orgId` filter inside `lib/cases.ts` (never trust a client-supplied `orgId`).

---

## 4. Monetization — marketplace payments & author payouts

### Recommendation: **Stripe Connect (Express accounts) + destination charges with `application_fee_amount`.**

Stripe Connect is the standard for marketplaces that must onboard third-party sellers and
move money to them; **Express** accounts give Stripe-hosted onboarding/KYC and a payout
dashboard with minimal liability on us, and **destination charges with an application fee**
let us take the platform's cut on each sale and route the remainder to the author's connected
account automatically.
([Stripe Connect](https://stripe.com/connect),
[Connect docs](https://docs.stripe.com/connect),
[payouts to connected accounts](https://docs.stripe.com/connect/marketplace/tasks/payout))

**Pricing models we support (all expressed as `Product` + `Entitlement`):**

| Model | Mechanism |
|---|---|
| **Free** | `Product.price = 0`; entitlement granted on enrollment. (All P0/P1 content is free.) |
| **One-off paid course/bundle** | Destination charge; author gets `net = price − platformFee − Stripe fee`. |
| **Learner subscription** ("all-access") | Stripe Subscription; entitlement = active sub. Author payouts via a revenue-share pool by watch/enrollment. |
| **Institutional seats** | `seatpack` Product → org-scoped Entitlement; every member inherits access. The B2B revenue line. |

**Revenue share & payouts.** Platform takes a configurable application fee (start ~20–30%
gross, the marketplace norm); Stripe's processing (2.9% + 30¢, +0.25% payout fee capped at $25)
is netted before author payout. Use **configurable split ratios per transaction** and the
ability to **delay/hold funds** until refund windows close — both first-class in Connect and
important for dispute/refund trust on a CME product.
([Stripe Connect pricing](https://stripe.com/connect/pricing),
[Sharetribe: Connect overview](https://www.sharetribe.com/academy/marketplace-payments/stripe-connect-overview/))

**The entitlement gate.** Catalog and lesson routes call `hasEntitlement(user, product)` before
serving paid pixels/narration. Free content skips the check. This is the *only* new gate in the
learner path; everything else (viewer, tutor, progress) is unchanged.

**Business vs engineering split.** *Engineering:* Connect onboarding, checkout, webhooks
(`payment_intent.succeeded` → grant entitlement; `account.updated` → mark author payable),
entitlement gate, payout reconciliation. *Business (not code):* the actual revenue-share %,
refund policy, tax handling (Stripe Tax), payout schedule, and Connect platform terms —
decide these before charging a cent. Keep all of payments behind `lib/payments.ts` (one seam,
like `lib/auth.ts`).

**Biggest risk:** charging for medical-education content while a study still carries PHI is a
medical-legal catastrophe. Money therefore ships **after** the de-id publish gate (§7) is hard —
never before.

---

## 5. Assessment & CME

### The differentiator: assessment **on the DICOM viewer we already own.**

Coursera/Udemy can only ask *about* an image. We can ask the learner to **act on the pixels**:

1. **Click-the-finding** (`Question.kind = 'click_finding'`). The learner clicks the viewport;
   we compare the click (already captured in normalized `[0,1]`, see `RecordedEvent.cursor` /
   `Marker`) to the stored `finding.marker` within `toleranceRadiusPct`. **Zero new imaging
   infra** — we store markers in `[0,1]` precisely so this works across zoom/resolution.
2. **MCQ** — standard, for recall/knowledge checks between cases.
3. **AI-graded structured report** (`kind = 'report'`). The learner **dictates an impression**
   (same mic → STT path as Q&A); Gemini grades it against a rubric and the author's model
   answer, returning a score + targeted feedback. This is the existing `reporting` mode in
   `lib/gemini.ts` turned into a graded tool call — the plumbing already exists. Structured/
   rubric-based grading of radiology reports is an active, validated direction in the
   literature.
   ([Rad-ReStruct: structured reporting benchmark](https://arxiv.org/pdf/2307.05766),
   [AI analysis of radiology reports](https://pmc.ncbi.nlm.nih.gov/articles/PMC12569488/))

Grading: deterministic for click/MCQ; for reports, Gemini returns `{ score, matchedFindings[],
missedFindings[], feedback }` via a JSON-only call (the `jsonOnly` path already exists). Always
show the rubric breakdown — never an opaque AI number.

### CME credit & certificates

On passing a `cmeEligible` assessment, issue a **`Certificate`** (serial, credits, accreditation
statement, PDF). The mechanics — *post-test ≥ a passing score (commonly 75%) + a course
evaluation → AMA PRA Category 1 Credit certificate* — match how accredited enduring-material
radiology CME already works.
([RSNA CME](https://www.rsna.org/education/continuing-medical-education),
[BoardVitals radiology CME / enduring material](https://www.boardvitals.com/radiology-cme))

**Business note (do not skip):** *We cannot grant AMA PRA Category 1 Credit ourselves.* CME
must be **certified by an ACCME-accredited provider** (RSNA, ACR, a university, or a
joint-providership partner). The platform's job is to be the *technical delivery + assessment +
certificate-issuance system* under an accredited partner's umbrella, or to pursue accreditation
as a business track. Until then, FlowRad issues **"Certificate of Completion"** (non-CME) and
designs the assessment/eval/post-test flow to be *accreditation-ready* so a partner can certify
it without rework.
([ACCME enduring material requirements via RSNA/BoardVitals](https://www.boardvitals.com/radiology-cme),
[Oakstone: radiology CME requirements](https://oakstone.com/radiology-cme-credits))

**Biggest risk:** claiming "CME" before an accredited provider signs off is a compliance
violation. Gate the word "CME"/credit language behind a verified `accreditationProviderId` on
the course's org.

---

## 6. Surface / route map by persona

The current routes (`/`, `/case/[caseId]`, `/author`, `/admin`, `/course/[id]`,
`/playlist/[id]`, `/authors/[id]`, `/record`, `/upload`) evolve — **mostly additive**:

**Learner**
- `/` catalog *(exists)* → add personalization rails ("Continue", "For your subspecialty"),
  marketplace badges (price, CME, rating), and auth-aware "Enroll" CTAs.
- `/case/[caseId]` *(exists)* → unchanged player; add entitlement gate + progress writes.
- `/course/[id]` *(exists)* → becomes module/lesson outline with progress + enroll/buy.
- `/authors/[id]` *(exists)* → real `AuthorProfile` with verification badge, follow, ratings.
- `/learn` *(new)* — "My learning": enrollments, resume, certificates, attempts.
- `/checkout`, `/account` *(new)* — purchase + profile/billing.

**Author studio** (gated `author` role)
- `/studio` *(new hub; supersedes today's `/author` workspace)* — my courses/cases, drafts,
  earnings, reviews, learners.
- `/studio/courses/[id]` — build modules/lessons, objectives, pricing, assessment builder.
- `/author` (case editor) + `/record` *(exist)* — fold under the studio; keep the finding
  editor + record/replay as-is.
- `/studio/onboarding` *(new)* — sign-up → verification (credentials, NPI/registration) →
  Stripe Connect onboarding.

**Org / institution** (gated `admin`/`owner`)
- `/org` *(new)* — seats, members/invites, assigned curricula, completion + CME export,
  private-case management (today's `/admin` tenant features move here, org-scoped).

**Platform admin** (staff)
- `/platform` *(new)* — author **verification** queue, content **moderation**, **de-id**
  review queue, payouts, disputes, marketplace health.

**API** — existing `/api/admin/*`, `/api/cases/*`, `/api/catalog`, `/api/tutor`,
`/api/transcribe`, `/api/tts`, `/api/dicomweb` all stay. Add `/api/auth/*` (Clerk webhooks),
`/api/enrollments`, `/api/progress`, `/api/assessments/*`, `/api/attempts`, `/api/checkout`,
`/api/stripe/webhook`, `/api/payouts`, `/api/deid/*`. Every new route derives `orgId`/`userId`
from `lib/auth.ts` and authorizes via `requireRole`.

---

## 7. Trust, quality & compliance

A *public, multi-author, paid* medical platform lives or dies on trust. Four gates:

1. **Author verification** — `AuthorProfile.verification`. New authors are `unverified` and
   **cannot publish to the public marketplace**; a `VerificationRequest` (credentials, NPI/
   medical-registration number, institutional email or document) goes to the platform-admin
   queue. Verified authors get a badge; the credential shows on the profile + every case card.
2. **De-identification enforcement (hard publish gate).** Today `orthancIngestInstance` is a
   pass-through with a de-id TODO. For the marketplace it becomes mandatory: on ingest we
   **scrub DICOM headers per DICOM PS3.15 / HIPAA Safe Harbor (18 identifiers)** *and* **OCR
   the pixels for burned-in PHI**, writing a `DeidReport`. **Publishing a case is blocked
   unless every referenced study has a passing report**; suspected pixel PHI is black-boxed or
   flagged for manual review. This is well-trodden ground (header + pixel scrubbing, OCR
   detection, Safe Harbor) and slots into the *single* ingest seam.
   ([DICOM de-id / Safe Harbor / burned-in PHI](https://healthcareonlinetools.com/en/blog/dicom-tools/dicom-de-identification-removing-phi-from-medical-images/),
   [De-id pipeline, PS3.15 + Safe Harbor](https://arxiv.org/pdf/2508.07538))
3. **Content review** — first publish by a new author (and any flagged content) enters a
   review queue; a `ModerationRecord` records the decision. Established verified authors can be
   auto-approved with post-hoc spot checks.
4. **Ratings & moderation** — `Review` with `status` for flag/remove; ratings roll up to
   `AuthorProfile.stats`; learners can report a case (factual error, PHI suspicion → routes
   straight to the de-id/moderation queue).

**Biggest risk overall:** a single study with residual PHI on a public, paid platform. The de-id
gate is therefore *infrastructure*, not a feature — it ships before any public author onboarding
(it's a P0/P1 dependency, pulled earlier than its "compliance" framing suggests).

---

## 8. System architecture & seams

```
                         ┌─────────────────────────────────────────────┐
   Browser (Next 14) ───▶│  Next app (App Router, RSC + API routes)     │
   - Cornerstone viewer  │  Seams: lib/auth · lib/cases · lib/payments  │
   - Student session/orb  │         lib/orthanc · lib/gemini · lib/deid │
   - Studio / catalog     └───┬───────┬───────┬───────┬────────┬────────┘
                              │       │       │       │        │
                       Clerk │  Mongo │ Orthanc│ Gemini│ Stripe │ Email/R2
                      (auth) │(domain)│(DICOM- │ (STT/ │(Connect│(notif/CDN
                             │        │ web)   │ tutor/│ pay/   │ for pixels
                             │        │        │ grade)│ payout)│ + audio)
                             ▼        ▼        ▼       ▼        ▼
```

- **Next app** — unchanged shape; new seams added beside existing ones. RSC for catalog/SEO,
  client islands for the viewer/tutor (already the pattern).
- **MongoDB** *(domain data)* — the STORE SEAM lights up at scale; all new collections live
  here. Keep the JSON store as the dev/test fallback.
- **Orthanc / DICOMweb** *(pixels)* — unchanged; reached only via `lib/orthanc.ts` + the
  `/api/dicomweb` proxy. The ingest seam (`orthancIngestInstance`) gains de-id.
- **Object storage + CDN (Cloudflare R2 / S3 + CDN)** *(new)* — for **narration audio**
  (`RecordedTrack.audioUrl` today is a local key), certificate PDFs, avatars/banners, and
  cached/compressed DICOM frames. Decouples large binaries from Mongo and makes the
  "prefetch aggressively" goal (CLAUDE.md §4a) CDN-backed. Today audio lives behind
  `/api/audio` — repoint that seam at R2.
- **Gemini** *(AI)* — unchanged two-call discipline; **add a third tool schema for report
  grading** (same `generate()` + `jsonOnly`). No new vendor.
- **Stripe** *(money)* — behind `lib/payments.ts`; webhooks are the source of truth for
  entitlements/payouts.
- **Email** *(new)* — transactional (Resend/Postmark) behind `lib/notify.ts` for verification
  results, enrollment, payout, certificate delivery.

**Refactor (small, surgical):**
- Replace ~all `DEFAULT_ORG_ID` call sites with `activeOrgId()` from `lib/auth.ts`.
- Migrate `Author` → `AuthorProfile` (add `userId` + `verification`; same id space).
- Add `lib/auth.ts`, `lib/payments.ts`, `lib/deid.ts`, `lib/notify.ts` as new seams.
- Repoint `/api/audio` and DICOM-frame caching at object storage/CDN.

**Keep (do not touch):** the `Collection`/`collection()` STORE SEAM, the Mongo singleton +
lazy connect, the viewer-state model (`Marker`/`Keyframe`/`RecordedTrack`), the Gemini
two-call split, the catalog facet/filter engine, the design system in `components/ui/`.

---

## 9. Design & brand direction

Today's theme (a tasteful dark shadcn "reading room" with an electric-cyan accent —
`tailwind.config.ts`, `AppShell`) is *good*, but reads close to "generic premium AI SaaS."
To own the category — *"the marketplace where radiologists teach radiology"* — push toward a
**domain-authentic radiology aesthetic** that a radiology department would recognize as *theirs*:

- **Editorial, not dashboard.** Course/author pages should feel like a respected journal or an
  RSNA exhibit — a real **display serif** for course and author titles (paired with Inter for
  UI), generous measure, confident hierarchy. Escape the uniform 14px-everywhere SaaS look.
- **Reading-room density where it counts.** The viewer and assessment surfaces stay PACS-dense
  and pure-black (`bg-imaging` is already enforced); the marketplace surfaces breathe. The
  *contrast* between dense clinical surfaces and editorial catalog surfaces is the signature.
- **A memorable, clinical brand system.** Lean into radiology's own visual language —
  reticles/crosshairs (the `BrandMark` already hints at this), windowing gradients, the
  grayscale ramp of a CT window, measurement calipers and tabular numerics as *brand* elements,
  not just UI. One decisive accent stays; add a warm secondary for "human/educator" surfaces
  (author profiles, reviews) so the platform doesn't read as cold machinery.
- **Trust signals as first-class UI.** Verification badges, credentials ("MD, FRCR"),
  institution lockups, CME marks, de-id-verified seals — designed, not bolted on. On a medical
  marketplace, *credibility is the product*; the design must broadcast it.
- **Author branding.** Orgs/authors get light branding (logo, accent) on their profile/course
  pages — a marketplace where the *teacher's* identity is visible, not flattened into our chrome.

Keep everything inside the existing token system and `components/ui/` (CLAUDE.md §1) — this is a
*direction* (typography, brand motifs, trust UI), not a re-skin that forks the design system.

---

## 10. Phased roadmap

> Sequencing principle: **identity unblocks multi-author; de-id unblocks public publishing;
> assessment is the differentiator; money comes last.** Each phase is shippable and leaves the
> build green.

### P0 — Identity, author onboarding & real profiles  *(unblocks "multi-author")*
**Scope:** Clerk integration behind `lib/auth.ts`; `User`/`Org`/`Membership` synced via
webhooks; RBAC (`requireRole`, `activeOrgId`) replacing `DEFAULT_ORG_ID`; migrate
`Author` → verified `AuthorProfile` (tied to a `User`); author sign-up + `/studio` shell +
verification request flow; real `/authors/[id]` profiles. **Pull the de-id ingest gate
(`lib/deid.ts`) forward into P0** so the first real uploads are clean.
**Deltas:** *Data:* `Membership`, extend `User`/`Org`, `AuthorProfile`, `VerificationRequest`,
`DeidReport`. *API:* `/api/auth/webhook`, verification + de-id routes; thread auth through all
existing routes. *UI:* sign-in/up, studio shell, profile, verification, AppShell role-aware nav.
**Dependencies:** none (foundational). **Effort:** L (3–5 wks). **Biggest risk:** tenancy
isolation bugs leaking drafts/PHI across orgs — mitigate with the single `assertOrgAccess`
chokepoint + a per-role integration-test matrix.

### P1 — Enrollment, progress & richer catalog
**Scope:** `Enrollment`/`Progress` (resume, completion %); Course → Module → Lesson structure
(with legacy `caseIds` migration); personalized rails ("Continue", "For your subspecialty");
`/learn` ("My learning"); harden de-id review queue in `/platform`.
**Deltas:** *Data:* `Enrollment`, `Progress`, extend `Course` (+`Module`/`Lesson`). *API:*
`/api/enrollments`, `/api/progress`. *UI:* `/learn`, course outline, resume, progress on cards.
**Dependencies:** P0 (needs a user to enroll). **Effort:** M (2–3 wks). **Biggest risk:**
progress/resume fidelity against the viewer-state model — reuse `viewerCheckpoints`, don't
invent a parallel position model.

### P2 — Assessment & CME-ready certificates
**Scope:** `Assessment`/`Question`/`Attempt`; the three question types (**click-finding** on the
viewer, **MCQ**, **AI-graded report** via Gemini); pass logic; **Certificate of Completion**
(accreditation-ready, CME-gated behind a provider org); author assessment builder in `/studio`.
**Deltas:** *Data:* `Assessment`, `Question`, `Attempt`, `Certificate`. *API:*
`/api/assessments/*`, `/api/attempts`, `/api/certificates`. *UI:* in-viewer question runner,
report-grading panel, assessment builder, certificate viewer/PDF.
**Dependencies:** P1 (assessment is a lesson type). **Effort:** L (3–5 wks). **Biggest risk:**
AI report-grading quality/consistency — pin a JSON rubric schema, always show the rubric
breakdown, allow author override; never present a bare AI score.

### P3 — Monetization & author payouts
**Scope:** `Product`/`Order`/`Entitlement`/`Subscription`; Stripe Connect Express onboarding in
the studio; checkout; entitlement gate on paid lessons; revenue share + `Payout` reconciliation;
webhooks as source of truth.
**Deltas:** *Data:* `Product`, `Order`, `Entitlement`, `Subscription`, `Payout`. *API:*
`/api/checkout`, `/api/stripe/webhook`, `/api/payouts`. *UI:* pricing in studio, checkout,
earnings dashboard, paywall on cards/lessons.
**Dependencies:** P0 (Connect needs verified authors), P1/P2 (something worth selling).
**Effort:** L (3–5 wks). **Biggest risk:** entitlement/refund/webhook edge cases granting or
revoking access incorrectly — webhooks (not client redirects) are the only source of truth;
hold funds through the refund window before payout.

### P4 — Org dashboards, analytics & notifications
**Scope:** Institution seats + member invites (Clerk orgs); `/org` dashboard (assign curricula,
completion + CME export for ACGME/audit); `Review` ratings surfaced everywhere; `Notification`
system + transactional email; author analytics (learners, completion, revenue).
**Deltas:** *Data:* `Review`, `Notification`, seat entitlements, analytics rollups. *API:*
`/api/org/*`, `/api/notifications`, `/api/reviews`. *UI:* `/org` dashboard, notifications,
ratings UI, analytics charts.
**Dependencies:** P3 (seats are a product), P1–P2 (data to report on). **Effort:** M–L
(3–4 wks). **Biggest risk:** analytics queries over per-learner progress not scaling — design
rollup/aggregation collections from the start, don't compute over raw events at read time.

---

## Sources

- [Better Auth vs Clerk vs Auth.js for Next.js (2026)](https://www.buildmvpfast.com/blog/better-auth-vs-clerk-vs-authjs-nextjs-decision-tree-2026)
- [Better Auth vs Clerk vs NextAuth vs Supabase (2026)](https://makerkit.dev/blog/tutorials/better-auth-vs-clerk)
- [Clerk — Organizations & RBAC in Next.js](https://clerk.com/articles/organizations-and-role-based-access-control-in-nextjs)
- [Stripe Connect](https://stripe.com/connect) · [Connect docs](https://docs.stripe.com/connect) · [Connect pricing](https://stripe.com/connect/pricing) · [Payouts to connected accounts](https://docs.stripe.com/connect/marketplace/tasks/payout)
- [Sharetribe — Stripe Connect overview](https://www.sharetribe.com/academy/marketplace-payments/stripe-connect-overview/)
- [RSNA — Radiology CME](https://www.rsna.org/education/continuing-medical-education) · [BoardVitals — Radiology CME / enduring material](https://www.boardvitals.com/radiology-cme) · [Oakstone — Radiology CME requirements](https://oakstone.com/radiology-cme-credits)
- [DICOM de-identification & Safe Harbor / burned-in PHI](https://healthcareonlinetools.com/en/blog/dicom-tools/dicom-de-identification-removing-phi-from-medical-images/) · [De-id pipeline (PS3.15 + Safe Harbor)](https://arxiv.org/pdf/2508.07538)
- [Rad-ReStruct — structured radiology reporting benchmark](https://arxiv.org/pdf/2307.05766) · [AI analysis of radiology reports](https://pmc.ncbi.nlm.nih.gov/articles/PMC12569488/)
