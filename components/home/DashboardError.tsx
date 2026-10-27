"use client";

import { WarningCircle } from "@phosphor-icons/react";
import { Button, EmptyState, PageContainer } from "@/components/ui";

/** Shown when a server-rendered catalog/home load fails. A tiny client
 * island so the retry action can reload the page. */
export function DashboardError({
  title = "Couldn't load this page",
  message,
}: {
  title?: string;
  message: string;
}) {
  return (
    <PageContainer>
      <EmptyState
        icon={<WarningCircle aria-hidden="true" weight="regular" />}
        title={title}
        description={message}
        action={
          <Button variant="secondary" onClick={() => location.reload()}>
            Retry
          </Button>
        }
      />
    </PageContainer>
  );
}
