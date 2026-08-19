"use client";

import { useEffect } from "react";

/**
 * When a learner opens a case from a course curriculum (?course=),
 * record lastOpened so Continue Learning resumes here (Udemy/Coursera pattern).
 */
export function RecordCaseOpen({
  courseId,
  caseId,
}: {
  courseId?: string | null;
  caseId: string;
}) {
  useEffect(() => {
    if (!courseId) return;
    void fetch("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        courseId,
        caseId,
        lastOpenedCaseId: caseId,
      }),
    }).catch(() => undefined);
  }, [courseId, caseId]);

  return null;
}
