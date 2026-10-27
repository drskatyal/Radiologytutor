import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
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
    <html lang="en" className={sans.variable}>
      <body className="font-sans">
        <AppShell demoEnabled={demoAuthEnabled()}>{children}</AppShell>
      </body>
    </html>
  );
}
