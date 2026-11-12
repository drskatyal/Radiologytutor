// The shared viewer's page frame: a full-height reading room with a slim brand
// bar, the reader (ViewerFrame over a source adapter), and the FlowRad product
// links. Used by /viewer (the public FlowRad Viewer) and /viewer/local (the
// same reader inside FlowRad Learn), so both look and behave the same; only
// the bar's label and links differ. Both read local files; `source` is the
// seam a RadLearn surface uses for archive series.
//
// Server component: no session, no data fetching. Theme tokens come from
// `.viewer-shell` (app/globals.css): paper or dark with the system, black
// once a study is open.

import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { ProductLinks } from "@/components/marketing/ProductLinks";
import { ViewerFrame, type ViewerFrameSource } from "@/components/viewer/ViewerFrame";
import { ViewerPrewarm } from "@/components/viewer/ViewerPrewarm";
// Imported, not referenced by /brand/ path: Next copies the files byte for
// byte to a hashed /_next/static/media/ URL. The dark lockup can first load
// after a drop (the shell turns black when a study opens), and after a drop
// this page may only make static asset GETs (free-viewer.perf.spec privacy).
import lockupLight from "@/public/brand/flowrad-lockup.svg";
import lockupDark from "@/public/brand/flowrad-lockup-dark.svg";

export interface ViewerShellProps {
  /** Where the lockup links, and its accessible name. */
  home: { href: string; label: string };
  /** The word beside the lockup ("Viewer", "Learn"). */
  product: string;
  /** A small pill after it (the public viewer's "Free"). */
  badge?: string;
  /** Extra controls at the right of the bar, before the privacy line. */
  actions?: ReactNode;
  /** Where studies come from (default: files from this computer). */
  source?: ViewerFrameSource;
}

export function ViewerShell({ home, product, badge, actions, source = { kind: "local" } }: ViewerShellProps) {
  return (
    <div className="viewer-shell group/shell flex h-dvh min-h-0 flex-col bg-vl-bg text-vl-fg">
      {/* The engine chunks warm while the user is choosing a folder. */}
      <ViewerPrewarm />
      <header className="flex shrink-0 items-center gap-2 border-b border-vl-border px-4 py-2 sm:gap-3">
        <Link
          href={home.href}
          aria-label={home.label}
          className="flex items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vl-brand"
        >
          {/* The approved Owl Scan lockups, byte for byte (brand/brand.md): the
              green wordmark on light, the white one on dark and while reading. */}
          <Image
            src={lockupLight}
            alt="FlowRad"
            width={120}
            height={32}
            // Lazy, not priority: the variant hidden by the theme is never
            // fetched, so first load pays for one ~8 KB lockup only.
            loading="lazy"
            unoptimized
            className="vl-logo-light h-8 w-auto"
          />
          <Image
            src={lockupDark}
            alt="FlowRad"
            width={113}
            height={32}
            loading="lazy"
            unoptimized
            className="vl-logo-dark h-8 w-auto"
          />
          <span className="text-sm font-semibold tracking-tight text-vl-muted">{product}</span>
        </Link>
        {badge ? (
          <span className="ml-1 hidden rounded-full border border-vl-brand/30 bg-vl-brand-soft px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-vl-brand sm:inline">
            {badge}
          </span>
        ) : null}
        <div className="ml-auto flex min-w-0 items-center gap-3 pl-3">
          <p className="hidden min-w-0 items-center gap-1.5 text-right text-xs leading-tight text-vl-muted sm:flex">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-vl-brand" aria-hidden />
            <span>Your images never leave your computer.</span>
          </p>
          {actions}
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col" aria-label="DICOM viewer">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6 sm:py-10 has-[[data-testid=local-stage]]:overflow-visible has-[[data-testid=local-stage]]:p-0">
          <ViewerFrame tone="reading" source={source} />
        </div>
      </main>
      {/* Theme tokens, so the links read on the paper landing and on the black reading room alike. */}
      {/* The diagnostic-use notice sits here, server-rendered and visible at every width,
          on the landing and while a study is open. On a phone with a study open
          the footer is that one line: the product links wrap to three rows
          there and would take ~120 px from the image. They stay on the landing. */}
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-5 gap-y-1 border-t border-vl-border px-4 py-2 text-vl-muted max-sm:group-has-[[data-testid=local-stage]]/shell:py-1">
        <p className="text-xs font-medium leading-5 text-vl-fg" data-testid="diagnostic-notice">
          For education and research. Not for diagnostic use.
        </p>
        <div className="max-sm:group-has-[[data-testid=local-stage]]/shell:hidden">
          <ProductLinks />
        </div>
      </footer>
    </div>
  );
}
