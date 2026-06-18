import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

// Inter — our body/UI typeface. Exposed as `--font-sans`. next/font self-hosts
// the font at build time; if Google can't be reached the `fallback` system
// stack keeps the build (and the UI) working.
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
  fallback: [
    "ui-sans-serif",
    "system-ui",
    "-apple-system",
    "Segoe UI",
    "Roboto",
    "Helvetica Neue",
    "Arial",
    "sans-serif",
  ],
});

// Space Grotesk — a modern geometric grotesk used for headings and brand marks.
// Gives the product a distinct, engineered voice next to Inter's neutral body.
const display = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  weight: ["500", "600", "700"],
  variable: "--font-display",
  fallback: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
});

export const metadata: Metadata = {
  title: "FlowRad Learn",
  description: "Interactive, voice-narrated radiology teaching cases.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
