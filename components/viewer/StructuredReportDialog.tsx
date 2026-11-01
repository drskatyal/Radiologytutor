"use client";

// A DICOM Structured Report, read as text: the content tree, indented by level.
// Shared by the web viewer (/viewer/local) and FlowRad Viewer (desktop).

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { DicomDocument } from "@flowrad/viewer-core";

function formatDate(da?: string): string {
  if (!da || !/^\d{8}$/.test(da)) return da ?? "";
  return `${da.slice(0, 4)}-${da.slice(4, 6)}-${da.slice(6, 8)}`;
}

export function StructuredReportDialog({ report, onClose }: { report: DicomDocument | null; onClose: () => void }) {
  const images = report?.references.length ?? 0;
  const description =
    [formatDate(report?.date), images ? `${images} referenced image${images === 1 ? "" : "s"}` : ""]
      .filter(Boolean)
      .join(" · ") || undefined;
  return (
    <Modal
      open={!!report}
      onClose={onClose}
      title={report?.title ?? "Structured report"}
      description={description}
      size="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {report && report.lines.length > 0 ? (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-canvas p-3 font-sans text-sm leading-relaxed text-primary">
          {report.lines.join("\n")}
        </pre>
      ) : (
        <p className="text-sm text-muted">This report has no readable content.</p>
      )}
    </Modal>
  );
}
