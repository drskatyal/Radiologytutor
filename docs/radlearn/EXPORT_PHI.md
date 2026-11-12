# Export and PHI boundary (addendum item 8)

Web and desktop image labels are built from coded modality, numeric series
number, image number and window values. The desktop identifying-overlay option
is removed; legacy full-overlay calls cannot include identifying lines. Study
and series descriptions, patient name/ID/birth date and institution are not
copied into exported overlays or file names. Non-placeholder identity values
fail the shared assertNoPhi boundary.

DICOM exports use an explicit imaging-tag allowlist. The web rewrite applies it
recursively, blanks identity tags, clears the preamble, preserves pixels and
supported functional-group geometry, and independently validates the rewritten
result. The native path applies the same allowlist before either file export or
sync serialization; unknown nested metadata and non-placeholder replacement
names/IDs fail closed. Tests keep the two allowlists identical. Free-text
reports, private extensions and unsupported metadata are deliberately omitted;
this is an image export, not a lossless general DICOM round-trip. Native nested
metadata outside the allowlist is rejected rather than guessed or copied.

Pixels and user annotations still require human PHI review; these guards do not
perform OCR or speech recognition. Finding approval and new case publication
require explicit boolean true review flags for pixels, audio and screen. Archive
metadata is checked before it can resolve an approvable finding. Active exams
also block general transcription endpoints; the exam accepts reviewed text only,
with the same guard applied before persistence/inference.

The synthetic tests cover the five requested identity families at root and
nested levels, dirty preambles, unchanged pixel bytes, retained image position
and spacing, metadata/overlay/file-name allowlists, and rejection before Gemini
transport. PR #130's absent sketch-export was not ported. Its future export must
use the same rules and the planned test in ACCEPTANCE_MAPPING.md.

Validation limitation: the standalone native policy tests run with rustc and
pass; the full desktop Rust integration cannot run offline because
`dicom-dictionary-std` is not cached. Desktop tsc also stops at missing
`vite/client` types. No dependencies were fetched. Native integration and the
full desktop build are **NOT VERIFIED**. Web production build, root tsc baseline,
unit suites and actual browser image/series/video/DICOM export are checked below
in the status/evidence logs.
