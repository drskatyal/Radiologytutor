import Link from "next/link";
import { Wordmark } from "@/components/brand/BrandMark";

export function SiteFooter({ teaching }: { teaching?: React.ReactNode }) {
  return (
    <footer className="bg-surface">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-12 sm:flex-row sm:items-end sm:justify-between sm:px-8">
        <div className="max-w-[65ch]">
          <Wordmark size="sm" />
          <p className="mt-2 text-sm text-secondary text-pretty">
            Teach radiology on the DICOM study. A teaching product, not a diagnostic device.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-4 text-sm font-semibold">
          <Link href="/library" className="text-secondary transition-colors duration-300 ease-draw hover:text-primary">
            Library
          </Link>
          {teaching ?? (
            <Link href="/sign-up" className="text-secondary transition-colors duration-300 ease-draw hover:text-primary">
              Start teaching
            </Link>
          )}
          <Link href="/privacy" className="text-secondary transition-colors duration-300 ease-draw hover:text-primary">
            Privacy
          </Link>
          <Link href="/terms" className="text-secondary transition-colors duration-300 ease-draw hover:text-primary">
            Terms
          </Link>
        </nav>
      </div>
    </footer>
  );
}
