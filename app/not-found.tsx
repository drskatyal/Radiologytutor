import Link from "next/link";
import { ScanSearch } from "lucide-react";
import { Button } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70dvh] max-w-[680px] flex-col justify-center px-4 py-24 sm:px-8">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <ScanSearch className="h-6 w-6" aria-hidden />
      </span>
      <p className="mt-6 text-sm font-semibold text-secondary">404</p>
      <h1 className="mt-4 font-display text-5xl font-medium tracking-tight text-balance">This page isn’t here.</h1>
      <p className="mt-4 text-base text-secondary text-pretty">
        The link may be old, or a shared study may have expired or been revoked by its owner.
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <Link href="/viewer">
          <Button>Open the free viewer</Button>
        </Link>
        <Link href="/" className="text-sm font-semibold text-secondary transition-colors hover:text-primary">
          FlowRad Viewer home
        </Link>
      </div>
    </main>
  );
}
