"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Award, Download } from "lucide-react";
import { Badge, Button, useToast } from "@/components/ui";
import type { Certificate } from "@/lib/types";

export function CourseCertificateCTA({
  courseId,
  percentComplete,
  existingCertificate,
  assessmentPassed = true,
  hasAssessment = false,
}: {
  courseId: string;
  percentComplete: number;
  existingCertificate?: Certificate | null;
  /** When the course has a post-test, must be true to claim. */
  assessmentPassed?: boolean;
  hasAssessment?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [certificate, setCertificate] = useState(existingCertificate ?? null);
  const [loading, setLoading] = useState(false);

  if (percentComplete < 100) return null;
  if (hasAssessment && !assessmentPassed && !certificate) return null;

  async function issue() {
    setLoading(true);
    try {
      const res = await fetch("/api/certificates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId }),
      });
      if (res.status === 401) {
        router.push(`/sign-in?next=/course/${encodeURIComponent(courseId)}`);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        certificate?: Certificate;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setCertificate(data.certificate ?? null);
      toast({ title: "Certificate issued", variant: "success" });
      router.refresh();
    } catch (e) {
      toast({
        title: "Could not issue certificate",
        description: (e as Error).message,
        variant: "danger",
      });
    } finally {
      setLoading(false);
    }
  }

  if (certificate) {
    return (
      <div className="rounded-xl border border-success/30 bg-success/5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-success/30 bg-success/10 text-success">
              <Award className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h3 className="font-display text-base font-semibold text-primary">
                Certificate of Completion
              </h3>
              <p className="mt-1 text-sm text-secondary">
                You finished every case
                {hasAssessment ? " and passed the post-test" : ""} in this course. View or print
                your certificate.
              </p>
              <Badge variant="neutral" className="mt-2">
                Not CME credit
              </Badge>
            </div>
          </div>
          <Link href={`/certificate/${certificate.id}`}>
            <Button
              variant="secondary"
              leadingIcon={<Download className="h-4 w-4" aria-hidden="true" />}
            >
              View certificate
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent">
            <Award className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="font-display text-base font-semibold text-primary">
              Course complete
            </h3>
            <p className="mt-1 text-sm text-secondary">
              Claim your Certificate of Completion — not AMA PRA Category 1 Credit.
            </p>
          </div>
        </div>
        <Button onClick={issue} loading={loading}>
          Get certificate
        </Button>
      </div>
    </div>
  );
}
