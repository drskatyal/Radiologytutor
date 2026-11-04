// viewer.flowrad.ai home. Ported from drskatyal/flowrad-viewer-site index.html.
// The web viewer card links to the live viewer. The Windows and macOS cards stay
// "coming soon" with a waitlist until signed, self-updating builds exist; they
// switch to real download links on their own when offeredInstaller() returns
// an installer (DESKTOP_DOWNLOADS_LIVE=1 + a signed manifest entry). No code
// change is needed to go live.

import type { Metadata } from "next";
import Link from "next/link";
import { PLATFORM_LABEL, downloadsLive, formatInstallerSize, loadDownloadsManifest, offeredInstaller, type DesktopPlatform } from "@/lib/cloud/downloads";
import { PLANS } from "@/lib/cloud/plans";

export const metadata: Metadata = {
  title: "FlowRad Viewer — Free DICOM Viewer for Web, Windows & macOS",
  description:
    "A free DICOM viewer. Open a study in your browser with no sign-in, or download it for Windows and macOS. Anonymise, store and share teaching studies with an account.",
  alternates: { canonical: "https://viewer.flowrad.ai/" },
  openGraph: {
    type: "website",
    url: "https://viewer.flowrad.ai/",
    title: "FlowRad Viewer — Free DICOM Viewer",
    description: "Open local DICOM studies. Web, Windows and macOS.",
    images: [{ url: "https://viewer.flowrad.ai/brand/og-1200x630.jpg", width: 1200, height: 630, alt: "FlowRad: AI radiology reporting" }],
  },
  twitter: { card: "summary_large_image", title: "FlowRad Viewer — Free DICOM Viewer", description: "A free viewer for local DICOM studies." },
};

export const revalidate = 300;

const INSTALLER_NOTE: Record<DesktopPlatform, string> = {
  windows: "For Windows 10 and 11 (64-bit). Opens folders, discs and ZIPs offline.",
  macos: "One universal app for Apple silicon and Intel Macs. Opens folders, discs and ZIPs offline.",
};

export default async function HomePage({ searchParams }: { searchParams: { unavailable?: string } }) {
  // Don't even fetch the manifest until downloads are switched on.
  const manifest = downloadsLive() ? await loadDownloadsManifest() : null;
  const unavailable = searchParams.unavailable === "windows" || searchParams.unavailable === "macos" ? searchParams.unavailable : null;

  return (
    <main id="main" className="viewer-main">
      <div className="w hero">
        <div>
          <div className="eyebrow">FlowRad Viewer · DICOM studies</div>
          <h1>
            Your study.
            <br />
            Your device.
            <br />
            <em>A clearer view.</em>
          </h1>
          <p className="lead">
            A free DICOM viewer for the browser, Windows and macOS. Open a study in seconds with no sign-in. When you
            want to keep or share a teaching case, anonymise it in your browser and store it.
          </p>
          <div className="ctas">
            <Link className="b bp" href="/viewer">
              Open the web viewer →
            </Link>
            <a className="b bo" href="#get-viewer">
              Windows and macOS apps
            </a>
          </div>
          <p className="fine">For education and research. Not for diagnostic use.</p>
        </div>
        <div className="viewer-symbol">
          <p>How it works</p>
          <ol className="vs-steps">
            <li>
              <b>1</b>
              <span>Open a DICOM folder or drop image files</span>
            </li>
            <li>
              <b>2</b>
              <span>Browse the grouped studies and series</span>
            </li>
            <li>
              <b>3</b>
              <span>Scroll, window, measure and reconstruct</span>
            </li>
          </ol>
          <p className="vs-note">Files you open stay on your device</p>
        </div>
      </div>

      <section id="get-viewer" className="tint">
        <div className="w">
          <div className="eyebrow">Choose how you work</div>
          <h2>
            Three free tracks. <em>Choose yours.</em>
          </h2>
          <p className="sub">
            The web viewer works now in any modern browser. The Windows and macOS apps are coming soon: join the list to hear
            when yours is available.
          </p>
          {unavailable && (
            <p className="privacy-note" role="status">
              The {PLATFORM_LABEL[unavailable]} app is coming soon. The web viewer works today.
            </p>
          )}
          <div className="tracks">
            <article className="card track">
              <span className="badge">Available now</span>
              <h3>Web Viewer</h3>
              <p>Free · No sign-in. Runs in your browser. Nothing is uploaded.</p>
              <Link className="b bp" href="/viewer">
                Open the web viewer →
              </Link>
            </article>
            {(["windows", "macos"] as const).map((p) => {
              const entry = offeredInstaller(manifest, p);
              const size = formatInstallerSize(entry?.bytes);
              return (
                <article key={p} className="card track" data-testid={`track-${p}`}>
                  <span className={entry ? "badge" : "badge s"}>{entry ? `Version ${manifest!.version}` : "Coming soon"}</span>
                  <h3>{PLATFORM_LABEL[p]} download</h3>
                  <p>
                    {INSTALLER_NOTE[p]}
                    {entry && size ? ` ${size}.` : ""}
                    {!entry && " Not available yet. Join the waitlist for release news."}
                  </p>
                  {entry ? (
                    <a className="b bp" href={`/download/${p}`} data-testid={`download-${p}`}>
                      Download for {PLATFORM_LABEL[p]} ↓
                    </a>
                  ) : (
                    <a className="b bo" href={`mailto:support@flowrad.ai?subject=FlowRad%20Viewer%20${PLATFORM_LABEL[p]}%20waitlist`} data-testid={`waitlist-${p}`}>
                      Join the {PLATFORM_LABEL[p]} waitlist →
                    </a>
                  )}
                </article>
              );
            })}
          </div>
          <div className="privacy-note">
            <strong>Web Viewer: files you open stay on your device.</strong> The web viewer reads the files you choose in
            your browser. It does not upload the study. The website needs a connection to load the viewer.
          </div>
        </div>
      </section>

      <section id="viewer-features">
        <div className="w">
          <div className="eyebrow">Inside the viewer</div>
          <h2>
            The tools to <em>work through a study.</em>
          </h2>
          <div className="feat">
            <article className="card">
              <h3>Open a study folder</h3>
              <p>Drop a folder, a ZIP or image files from your computer. Browse the grouped studies and series.</p>
            </article>
            <article className="card">
              <h3>Scroll and window</h3>
              <p>Move through slices, adjust window and level, pan, zoom and play a series in cine mode. Say “bone window” to switch presets by voice.</p>
            </article>
            <article className="card">
              <h3>Measure and reconstruct</h3>
              <p>Use length and angle measurements, region tools and multiplanar reconstruction with compatible image geometry.</p>
            </article>
          </div>
          <p className="fine">Some media need the image folder selected directly: DICOMDIR indexes are skipped. Available tools depend on the study.</p>
        </div>
      </section>

      <section id="store-and-share" className="tint">
        <div className="w">
          <div className="eyebrow">With a free account</div>
          <h2>
            Keep a teaching file. <em>Share it safely.</em>
          </h2>
          <p className="sub">Viewing never needs an account. Sign in when you want to keep a study, write it up, or send it to a colleague.</p>
          <div className="feat">
            <article className="card">
              <h3>Anonymise in your browser</h3>
              <p>
                Patient names, IDs, dates of birth, physicians and institutions are removed on your device before
                anything is uploaded. The server checks again and refuses a file that still carries them.
              </p>
            </article>
            <article className="card">
              <h3>Write up each study</h3>
              <p>Add the clinical history, findings, diagnosis and tags, and save your measurements and arrows with the images.</p>
            </article>
            <article className="card">
              <h3>Share view-only links</h3>
              <p>
                Send a study as an unknown or with its findings. Links can expire, and you can revoke one at any time.
                Group studies into collections, embed them in a page, and allow downloads when you choose.
              </p>
            </article>
          </div>
          <p className="fine">
            Burned-in text in the pixels is not detected automatically. Check the images before you store them.{" "}
            <Link href="/pricing">Plans start free with {PLANS[0]!.studyLimit} stored studies.</Link>
          </p>
          <div className="ctas mt">
            <Link className="b bp" href="/sign-in">
              Create a free account
            </Link>
            <Link className="b bo" href="/pricing">
              Compare plans
            </Link>
          </div>
        </div>
      </section>

      <section className="dark">
        <div className="w">
          <div className="eyebrow">Part of FlowRad</div>
          <h2>
            From the images <em>to your report.</em>
          </h2>
          <p className="sub">Explore FlowRad Canvas for dictation, structured drafts and report review.</p>
          <p>
            <a className="b light" href="https://canvas.flowrad.ai/sign-in">
              Open FlowRad Canvas →
            </a>
          </p>
        </div>
      </section>
    </main>
  );
}
