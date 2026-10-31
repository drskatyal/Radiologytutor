import type { Metadata, Viewport } from "next";
import { Manrope, Shantell_Sans } from "next/font/google";
import { AppShell } from "@/components/AppShell";
import { demoAuthEnabled } from "@/lib/auth";
import "./globals.css";

export const dynamic = "force-dynamic";

const sans = Manrope({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const hand = Shantell_Sans({
  subsets: ["latin"],
  display: "swap",
  weight: ["500", "700"],
  variable: "--font-hand",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "RadLearn",
  description:
    "Teach radiology on the DICOM study. Record a case once. Registrars replay it with an AI tutor that drives scroll, window, and zoom.",
  openGraph: {
    title: "RadLearn",
    description:
      "Teach radiology on the DICOM study. Record a case once. Registrars replay it with an AI tutor that drives scroll, window, and zoom.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${hand.variable}`}>
      <body className="font-sans">
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){function swallow(e){var r=e.reason||e.error;var m=String((r&&r.message)||e.message||"");if((r&&r.name)==="AbortError"||m.indexOf("samplesPerPixel")!==-1){e.preventDefault();e.stopImmediatePropagation();}}window.addEventListener("unhandledrejection",swallow,true);window.addEventListener("error",swallow,true);})();`,
          }}
        />
        <AppShell demoEnabled={demoAuthEnabled()}>{children}</AppShell>
      </body>
    </html>
  );
}
