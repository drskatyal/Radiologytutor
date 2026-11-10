"use client";

// Settings › Privacy & storage for the free viewer, as the desktop's "Local
// study database": whether this browser keeps a list of the folders opened
// (description, modality, date and counts; never a patient name, ID or
// image) so they can be reopened, searched, and compared with a prior.

import { useState } from "react";
import { Switch } from "@/components/ui";
import { setRecentStudiesEnabled, useRecentStudiesEnabled } from "@/lib/recentStudiesSetting";

export function PrivacySettings() {
  const on = useRecentStudiesEnabled();
  const [cleared, setCleared] = useState(false);
  return (
    <section aria-labelledby="privacy-settings-title" className="mb-5 border-b border-white/10 pb-4">
      <h3 id="privacy-settings-title" className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/45">
        Privacy &amp; storage
      </h3>
      <Switch
        tone="imaging"
        label="Remember studies I open"
        description="Keeps a list of the folders you open in this browser (description, modality, date and counts: never a patient name, ID or image) so you can reopen, search and compare with a prior. Turning it off clears the list."
        checked={on}
        onChange={(next) => {
          setCleared(false);
          void setRecentStudiesEnabled(next).then(() => setCleared(!next));
        }}
      />
      {cleared && (
        <p role="status" className="text-xs text-white/60">
          Recent studies cleared. Nothing you open is remembered.
        </p>
      )}
    </section>
  );
}
