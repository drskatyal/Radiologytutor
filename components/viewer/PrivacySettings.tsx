"use client";

// Settings › Privacy & storage for the free viewer, as the desktop's "Local
// study database": whether this browser keeps a list of the folders opened
// (description, modality, date and counts; never a patient name, ID or
// image) so they can be reopened, searched, and compared with a prior.

import { useCallback, useEffect, useState } from "react";
import { Button, Switch } from "@/components/ui";
import { setRecentStudiesEnabled, useRecentStudiesEnabled } from "@/lib/recentStudiesSetting";
import { listRecentStudies, removeAllKeptStudies } from "@/lib/recentStudyStore";
import { formatBytes } from "@/lib/studyLibrary";

export function PrivacySettings() {
  const on = useRecentStudiesEnabled();
  const [cleared, setCleared] = useState(false);
  // Studies kept in this browser (the desktop's archive): how many, how much, and Remove all.
  const [kept, setKept] = useState<{ count: number; bytes: number } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removed, setRemoved] = useState(false);
  const refresh = useCallback(() => {
    void listRecentStudies().then((list) => {
      const k = list.filter((e) => e.keptBytes);
      setKept({ count: k.length, bytes: k.reduce((n, e) => n + (e.keptBytes ?? 0), 0) });
    });
  }, []);
  useEffect(refresh, [refresh, on]);
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
          void setRecentStudiesEnabled(next).then(() => {
            setCleared(!next);
            refresh();
          });
        }}
      />
      {kept && (
        <div data-testid="kept-studies" className="flex items-center justify-between gap-4 py-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium text-white">Kept studies</span>
            <span className="text-xs tabular-nums text-white/50">
              {kept.count === 0
                ? "None. Keep one from the side panel to reopen it without its folder."
                : `${kept.count} ${kept.count === 1 ? "study" : "studies"} · ${formatBytes(kept.bytes)} in this browser`}
            </span>
          </div>
          <Button
            size="sm"
            variant="imaging"
            disabled={kept.count === 0}
            loading={removing}
            onClick={async () => {
              setRemoving(true);
              try {
                await removeAllKeptStudies();
                setRemoved(true);
                refresh();
              } finally {
                setRemoving(false);
              }
            }}
          >
            Remove all
          </Button>
        </div>
      )}
      {removed && (
        <p role="status" className="text-xs text-white/60">
          Kept copies removed. Recent studies still reopen from their folders.
        </p>
      )}
      {cleared && (
        <p role="status" className="text-xs text-white/60">
          Recent studies cleared. Nothing you open is remembered.
        </p>
      )}
    </section>
  );
}
