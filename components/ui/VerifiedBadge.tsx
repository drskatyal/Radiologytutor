import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Badge } from "./Badge";
import type { AuthorProfile } from "@/lib/types";

export type VerificationStatus = AuthorProfile["verification"];

export interface VerifiedBadgeProps {
  status?: VerificationStatus | null;
  className?: string;
}

/** Trust signal for author verification — prominent only when verified. */
export function VerifiedBadge({ status = "unverified", className }: VerifiedBadgeProps) {
  const resolved = status ?? "unverified";

  if (resolved === "verified") {
    return (
      <Badge variant="success" className={className}>
        <ShieldCheck className="h-3 w-3" aria-hidden="true" />
        Verified
      </Badge>
    );
  }

  switch (resolved) {
    case "pending":
      return (
        <Badge variant="neutral" className={className}>
          <ShieldQuestion className="h-3 w-3" aria-hidden="true" />
          Pending
        </Badge>
      );
    case "rejected":
      return (
        <Badge variant="neutral" className={className}>
          <ShieldAlert className="h-3 w-3" aria-hidden="true" />
          Rejected
        </Badge>
      );
    default:
      return (
        <Badge variant="neutral" className={className}>
          <ShieldQuestion className="h-3 w-3" aria-hidden="true" />
          Unverified
        </Badge>
      );
  }
}
