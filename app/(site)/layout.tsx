// Public marketing pages, merged in from drskatyal/flowrad-viewer-site.
// Brand: Owl Scan lockup from public/brand only, green #0F4D3A, self-hosted
// Inter + Cormorant. Plain clinical language; only claim features that exist.

import Script from "next/script";
import { SiteFooter, SiteHeader } from "@/components/site/SiteChrome";
import { currentUser } from "@/lib/cloud/auth";
import "./site.css";

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  const signedIn = Boolean(currentUser());
  return (
    <div className="fr-site">
      <link rel="stylesheet" href="/shared/flowrad-nav.css" />
      <a className="skip" href="#main">
        Skip to content
      </a>
      <SiteHeader signedIn={signedIn} />
      {children}
      <SiteFooter />
      <Script src="/shared/flowrad-nav.js" strategy="lazyOnload" />
    </div>
  );
}
