// Free local DICOM viewer — the browser half of docs/DESKTOP_PLAN.md.
//
// Public: no account, no archive, no upload. A radiologist with a study CD or
// a folder from a colleague can read it here in the same Cornerstone viewport
// the teaching product uses. The desktop build wraps this exact surface.

import { Breadcrumbs, PageContainer } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { LocalStudyViewer } from "@/components/viewer/LocalStudyViewer";
import { ViewerPrewarm } from "@/components/viewer/ViewerPrewarm";

export const metadata = {
  title: "Open a local study · RadLearn",
  description:
    "Read a DICOM study from your own computer. Scroll, window, measure and reconstruct three planes. Nothing is uploaded.",
};

export default function LocalViewerPage() {
  return (
    <>
      {/* The engine chunks are the same ones a case page needs; warm them
          while the user is still choosing a folder. */}
      <ViewerPrewarm />
      <PageHeader
        breadcrumbs={
          <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Local viewer" }]} />
        }
        title="Open a study from this computer"
        description="Drag in a study folder — a CD mount, a USB stick, a folder from a colleague. The files are read in your browser and never leave this machine."
      />
      <PageContainer className="pb-16">
        <LocalStudyViewer />
      </PageContainer>
    </>
  );
}
