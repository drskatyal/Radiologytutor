import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/cloud/auth";
import { devSignInEnabled, identityConfig } from "@/lib/cloud/session";
import { SignInPanel } from "@/components/account/SignInPanel";

export const metadata: Metadata = { title: "Sign in · FlowRad Viewer" };
export const dynamic = "force-dynamic";

/** Only same-site relative paths are allowed as a post-sign-in destination. */
function safeNext(next: string | undefined): string {
  return next && /^\/(?!\/)[\w\-/.?=&%]*$/.test(next) ? next : "/library";
}

export default function SignInPage({ searchParams }: { searchParams: { next?: string } }) {
  const next = safeNext(searchParams.next);
  if (currentUser()) redirect(next);
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-16">
      <Link href="/" aria-label="FlowRad Viewer home" className="mb-8 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <Image src="/brand/flowrad-lockup.svg" alt="FlowRad" width={130} height={34} unoptimized priority />
      </Link>
      <div className="w-full max-w-md rounded-2xl border border-subtle bg-surface p-8 shadow-sm">
        <h1 className="font-display text-4xl font-medium tracking-tight">Sign in to store and share</h1>
        <p className="mt-3 text-sm text-secondary">
          Viewing is free and needs no account.{" "}
          <Link href="/viewer" className="font-semibold text-accent underline-offset-2 hover:underline">
            Open the viewer
          </Link>{" "}
          to read a study without signing in.
        </p>
        <SignInPanel identity={identityConfig()} devSignIn={devSignInEnabled()} next={next} />
      </div>
      <p className="mt-6 max-w-md text-center text-xs text-muted">
        Studies are anonymised in your browser before they are stored. FlowRad Viewer is for education and research,
        not for diagnostic use.
      </p>
    </main>
  );
}
