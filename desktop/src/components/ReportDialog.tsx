// A DICOM Structured Report, read as text: the content tree, indented by level.

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import type { DicomDocument } from "../documents";
import { formatDicomDate } from "../study";

export function ReportDialog({ report, onClose }: { report: DicomDocument | null; onClose: () => void }) {
  const date = report?.date ? formatDicomDate(report.date) : "";
  const images = report?.references.length ?? 0;
  return (
    <Modal
      open={!!report}
      onClose={onClose}
      title={report?.title ?? "Structured report"}
      description={[date, images ? `${images} referenced image${images === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || undefined}
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
