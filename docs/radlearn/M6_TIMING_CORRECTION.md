# M6 dedicated correction of an obsolete timing expectation

Strategy §4 M6 requires invalid/overlapping media intervals to remain estimated
or unresolved, never replaced proportionally. The previous
`compile partitions missing times and still lands them on the track` test
asserted fabricated halves of the recording and derived an image landing from
those invented windows. This dedicated commit replaces that obsolete expectation
with stronger assertions: missing times stay null in evidence, reversed and
out-of-range values remain unchanged, overlaps are flagged, and invalid windows
produce neither suggested image geometry nor a teaching guide. Numeric zero in
the legacy display fields is only a compatibility sentinel; it is never evidence.

M6's retained-capture extractor will use the nullable evidence schema directly.
This change does not alter valid legacy timing or introduce M7/M8 behavior.
Synthetic tests only; Gemini live contract not verified. No live GCP call made.
