import Link from "next/link";
import { TeachMotif } from "@/components/brand/TeachMotif";
import { Button } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[70dvh] max-w-[680px] flex-col justify-center px-4 py-24 sm:px-8">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <TeachMotif kind="stack" />
      </span>
      <p className="mt-6 text-sm font-semibold text-secondary">404</p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance">This page is not in the library.</h1>
      <p className="mt-4 text-base text-secondary text-pretty">
        The link may be old, or the case was never published. Go home, or open the library.
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <Link href="/">
          <Button>Back to RadLearn</Button>
        </Link>
        <Link
          href="/library"
          className="text-sm font-semibold text-secondary transition-colors duration-300 ease-draw hover:text-primary"
        >
          Open the library
        </Link>
      </div>
    </div>
  );
}
