import { notFound } from "next/navigation";
import Link from "next/link";
import { Award, Printer } from "lucide-react";
import { getCertificate } from "@/lib/cases";
import { getSession } from "@/lib/auth";
import { Badge, Breadcrumbs, Button, PageContainer } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";
import { CertificatePrintButton } from "@/components/learning/CertificatePrintButton";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { id: string } }) {
  const certificate = await getCertificate(params.id);
  return {
    title: certificate
      ? `Certificate · ${certificate.courseTitle}`
      : "Certificate · FlowRad Learn",
  };
}

export default async function CertificatePage({ params }: { params: { id: string } }) {
  const session = await getSession();
  const certificate = await getCertificate(params.id);
  if (!certificate) notFound();
  if (!session || session.user.id !== certificate.userId) notFound();

  const issued = new Date(certificate.issuedAt).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <>
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: "My learning", href: "/learning" },
              { label: "Certificate" },
            ]}
          />
        }
        title="Certificate of Completion"
        description="This certifies course completion. It is not AMA PRA Category 1 Credit."
        actions={
          <div className="flex flex-wrap gap-2">
            <CertificatePrintButton />
            <Link href="/learning">
              <Button variant="secondary">Back to learning</Button>
            </Link>
          </div>
        }
      />

      <PageContainer width="narrow">
        <article
          id="certificate-document"
          className="relative overflow-hidden rounded-2xl border border-strong bg-elevated p-8 shadow-lg sm:p-12"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-accent/10 via-transparent to-transparent"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-4 rounded-xl border border-subtle"
          />

          <div className="relative flex flex-col items-center text-center">
            <span className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/30 bg-accent/10 text-accent">
              <Award className="h-7 w-7" aria-hidden="true" />
            </span>

            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
              FlowRad Learn
            </p>
            <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-primary sm:text-4xl">
              Certificate of Completion
            </h1>
            <p className="mt-2 max-w-md text-sm text-secondary">
              This certificate is awarded for successfully completing all interactive
              cases in the course below. It is not CME / AMA PRA Category 1 Credit.
            </p>

            <div className="my-10 w-full max-w-lg border-t border-b border-subtle py-8">
              <p className="text-sm text-muted">This certifies that</p>
              <p className="mt-2 font-display text-2xl font-semibold text-primary sm:text-3xl">
                {certificate.learnerName}
              </p>
              <p className="mt-6 text-sm text-muted">has completed</p>
              <p className="mt-2 font-display text-xl font-semibold text-accent sm:text-2xl">
                {certificate.courseTitle}
              </p>
            </div>

            <p className="text-sm tabular-nums text-secondary">Issued {issued}</p>
            <Badge variant="neutral" className="mt-4">
              Not CME eligible
            </Badge>

            <p className="mt-8 font-mono text-[10px] uppercase tracking-widest text-muted">
              Certificate ID {certificate.id}
            </p>
          </div>
        </article>

        <p className="mt-6 flex items-center justify-center gap-2 text-center text-xs text-muted print:hidden">
          <Printer className="h-3.5 w-3.5" aria-hidden="true" />
          Use Print to save as PDF for your records.
        </p>
      </PageContainer>
    </>
  );
}
