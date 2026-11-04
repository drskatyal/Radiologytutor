// Header and footer for the public pages (/, /pricing). The products menu and
// footer columns come from the shared FlowRad nav spec (site/shared), rendered
// to HTML by site/render-flowrad-nav.py, so they stay identical to flowrad.ai.

import Link from "next/link";
import { FLOWRAD_FOOTER_HTML, FLOWRAD_NAV_HTML } from "./flowradNav.generated";

export function SiteHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header>
      <div className="w nav">
        <a href="https://flowrad.ai/" aria-label="FlowRad home">
          {/* Official lockup, byte for byte (brand rules). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/flowrad-lockup.svg" alt="FlowRad" width={130} height={34} />
        </a>
        <div className="contents" dangerouslySetInnerHTML={{ __html: FLOWRAD_NAV_HTML }} />
        <Link className="l h" href="/viewer">
          Web viewer
        </Link>
        <Link className="l h" href="/#get-viewer">
          Downloads
        </Link>
        <Link className="l h" href="/pricing">
          Pricing
        </Link>
        <span className="sp" />
        {signedIn ? (
          <Link className="b bp" href="/library">
            Your library
          </Link>
        ) : (
          <>
            <Link className="l" href="/sign-in">
              Sign in
            </Link>
            <Link className="b bp" href="/viewer">
              Open viewer<span className="xs"> free</span>
            </Link>
          </>
        )}
      </div>
    </header>
  );
}

export function SiteFooter() {
  return <div dangerouslySetInnerHTML={{ __html: FLOWRAD_FOOTER_HTML }} />;
}
