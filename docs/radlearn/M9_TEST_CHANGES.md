# M9 existing-test contract correction

The fullscreen microphone assertion in `e2e/archive/student-session.spec.ts`
now expects the accessible name **Hold to ask** instead of **Open microphone**.
[Strategy §4 M9](/workspace/radlearn-build-strategy.md:327) requires press/release capture and removes the persistent open
session control. The assertion still requires the button to be in the viewport;
it has not been removed, skipped or relaxed. This correction is committed
separately from the implementation, as required by the build brief.
