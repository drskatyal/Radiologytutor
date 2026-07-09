"use client";

import { CircleAlert } from "lucide-react";
import { Button, EmptyState, PageContainer } from "@/components/ui";

/** Shown when the dashboard's server-side data loads fail. A tiny client
 * island so the retry action can reload the page. */
export function DashboardError({ message }: { message: string }) {
  return (
    <PageContainer>
      <EmptyState
        icon={<CircleAlert aria-hidden="true" />}
        title="Couldn't load your dashboard"
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
