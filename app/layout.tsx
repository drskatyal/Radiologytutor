import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ui";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0F4D3A",
};

export const metadata: Metadata = {
  metadataBase: new URL(process.env.PUBLIC_ORIGIN?.trim() || "https://viewer.flowrad.ai"),
  title: "FlowRad Viewer",
  description: "A free DICOM viewer for the web, Windows and macOS. Anonymise, store and share teaching studies.",
  openGraph: {
    siteName: "FlowRad Viewer",
    images: [{ url: "/brand/og-1200x630.jpg", width: 1200, height: 630, alt: "FlowRad" }],
  },
  // Listed in full: once `icons` is set, Next 14 stops emitting the file-based
  // app/icon.svg link.
  icons: {
    icon: [
      { url: "/brand/owlscan.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans">
        {/* Cornerstone's loaders reject aborted prefetches as unhandled
            promises; swallow those two known shapes so they don't surface as
            page errors while scrolling. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){function swallow(e){var r=e.reason||e.error;var m=String((r&&r.message)||e.message||"");if((r&&r.name)==="AbortError"||m.indexOf("samplesPerPixel")!==-1){e.preventDefault();e.stopImmediatePropagation();}}window.addEventListener("unhandledrejection",swallow,true);window.addEventListener("error",swallow,true);})();`,
          }}
        />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
