# Teaching marketplace research → FlowRad Learn

Audited **Udemy, Coursera, Skillshare, MasterClass, Teachable/Thinkific, edX/LinkedIn Learning**
(general teaching marketplaces — not radiology-specific). Mapped excellent patterns onto our
DICOM + AI-tutor product. Decisions below are locked for this iteration.

## What winners share

| Pattern | Who does it well | Why it converts / retains |
|---------|------------------|---------------------------|
| **Continue learning** / resume | Coursera, Udemy, LearnDash | Highest-value return action; cuts re-orientation drop-off |
| **Progress % + checklist curriculum** | Coursera, Udemy | Visible momentum; checkmarks on modules |
| **Wishlist / save for later** | Udemy, marketplace guides | Captures intent when not ready to enroll |
| **Ratings & reviews** | Udemy (4.5+ filter), Coursera | Trust; course selection skill on open marketplaces |
| **Certificate of completion** | Coursera (verified), Udemy (completion) | Motivation to finish; we gate **CME** until ACCME partner |
| **Instructor credibility** | MasterClass (brand), Coursera (institution) | We already verify teachers — surface it harder |
| **Faceted search + clear filters** | All mature catalogs | We have facets; keep chips + counts |
| **Free preview / audit** | Coursera audit, Udemy free samples | Catalog + first case open without paywall (already) |

## What we skip or defer

- **Stripe/Udemy sales theater** — India PSP later (`lib/payments.ts`); free enroll stays
- **Subscription-only Skillshare model** — free + future seats fits radiology better first
- **Celebrity MasterClass layout** — keep clinical reading-room aesthetic
- **AMA PRA Category 1 Credit** — Certificate of Completion only until accreditation partner

## Shipping this pack (autonomous)

1. **Progress** — per user×course: completed caseIds, lastOpenedCaseId, percentComplete
2. **Continue learning** — Library + `/learning` resume CTA
3. **Wishlist** — save courses; Library “Saved”
4. **Reviews** — 1–5 stars + optional text on courses; avg on course page
5. **Curriculum checkmarks** — course case list shows done / next
6. **Certificate of Completion** — issued when all cases in course completed (not CME)

Radiology-native differentiator remains: progress is toward *interactive cases on Orthanc*,
not video minutes watched.
