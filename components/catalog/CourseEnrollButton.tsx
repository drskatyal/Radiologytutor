"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PlayCircle } from "lucide-react";
import { Badge, Button, useToast } from "@/components/ui";

export function CourseEnrollButton({
  courseId,
  initiallyEnrolled = false,
  firstCaseId,
}: {
  courseId: string;
  initiallyEnrolled?: boolean;
  firstCaseId?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [enrolled, setEnrolled] = useState(initiallyEnrolled);
  const [loading, setLoading] = useState(false);

  if (enrolled && firstCaseId) {
    return (
      <Link href={`/case/${firstCaseId}`}>
        <Button
          variant="secondary"
          leadingIcon={<PlayCircle className="h-4 w-4" aria-hidden="true" />}
        >
          Continue
        </Button>
      </Link>
    );
  }

  if (enrolled) {
    return <Badge variant="success">Enrolled</Badge>;
  }

  async function enroll() {
    setLoading(true);
    try {
      const res = await fetch("/api/enrollments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId }),
      });
      if (res.status === 401) {
        router.push(`/sign-in?next=/course/${encodeURIComponent(courseId)}`);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || `Enrollment failed (${res.status})`);
      }
      setEnrolled(true);
      toast({
        title: "Enrolled",
        description: "You're enrolled in this course.",
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "Could not enroll",
        description: (e as Error).message,
        variant: "danger",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={enroll} loading={loading}>
      Enroll free
    </Button>
  );
}
