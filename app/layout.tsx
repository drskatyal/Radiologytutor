import type { Metadata } from "next";
import { Source_Sans_3, Source_Serif_4 } from "next/font/google";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

// Source Sans 3 — clinical UI face (not Inter). Exposed as `--font-sans`.
const sans = Source_Sans_3({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
  fallback: [
    "ui-sans-serif",
    "system-ui",
    "-apple-system",
    "Segoe UI",
    "Helvetica Neue",
    "Arial",
    "sans-serif",
  ],
});

// Source Serif 4 — editorial display for brand + course/author titles.
const display = Source_Serif_4({
  subsets: ["latin"],
  display: "swap",
  weight: ["500", "600", "700"],
  variable: "--font-display",
  fallback: ["ui-serif", "Georgia", "Times New Roman", "serif"],
});

export const metadata: Metadata = {
  title: "FlowRad Learn",
  description:
    "Radiology, taught on the study — narrated DICOM cases with an AI tutor.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
