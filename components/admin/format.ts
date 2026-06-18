// Small formatting helpers for the admin console.

import type { CaseStatus } from "./types";

/** Format a DICOM "YYYYMMDD" or ISO date for display; passthrough otherwise. */
export function formatStudyDate(date?: string): string {
  if (!date) return "Undated";
  const dicom = /^(\d{4})(\d{2})(\d{2})$/.exec(date);
  if (dicom) return `${dicom[1]}-${dicom[2]}-${dicom[3]}`;
  const d = new Date(date);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  return date;
}

/** Relative "updated" label, e.g. "3h ago" / "Jun 18". */
export function formatUpdated(iso?: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export const STATUS_BADGE: Record<CaseStatus, "success" | "neutral"> = {
  published: "success",
  draft: "neutral",
};
