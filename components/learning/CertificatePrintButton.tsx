"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui";

export function CertificatePrintButton() {
  return (
    <Button
      variant="secondary"
      leadingIcon={<Printer className="h-4 w-4" aria-hidden="true" />}
      onClick={() => window.print()}
    >
      Print
    </Button>
  );
}
