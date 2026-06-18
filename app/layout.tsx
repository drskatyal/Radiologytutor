import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowRad Learn",
  description: "Interactive, voice-narrated radiology teaching cases.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-neutral-800 px-6 py-3 flex items-center gap-6">
          <Link href="/" className="font-semibold tracking-tight text-yellow-400">
            FlowRad Learn
          </Link>
          <nav className="flex gap-4 text-sm text-neutral-400">
            <Link href="/" className="hover:text-neutral-100">
              Cases
            </Link>
            <Link href="/author" className="hover:text-neutral-100">
              Author
            </Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
