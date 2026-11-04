// "Connect FlowRad Viewer for desktop to your account": the browser half of
// the desktop sign-in (device link). Sign in first, then confirm the code the
// app shows.

import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DeviceLinkApproval } from "@/components/account/DeviceLinkApproval";
import { currentUser } from "@/lib/cloud/auth";
import { normaliseUserCode } from "@/lib/cloud/entitlements";

export const metadata: Metadata = { title: "Connect the desktop app · FlowRad Viewer", robots: { index: false } };
export const dynamic = "force-dynamic";

export default function DesktopLinkPage({ searchParams }: { searchParams: { code?: string } }) {
  const code = normaliseUserCode(searchParams.code) ?? "";
  const user = currentUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/desktop/link${code ? `?code=${code}` : ""}`)}`);
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-16">
      <Link href="/" aria-label="FlowRad Viewer home" className="mb-8 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <Image src="/brand/flowrad-lockup.svg" alt="FlowRad" width={130} height={34} unoptimized priority />
      </Link>
      <div className="w-full max-w-md rounded-2xl border border-subtle bg-surface p-8 shadow-sm">
        <h1 className="font-display text-4xl font-medium tracking-tight">Connect the desktop app</h1>
        <p className="mt-3 text-sm text-secondary">
          Signed in as <span className="font-semibold text-primary">{user.email}</span>. Only confirm a code that FlowRad
          Viewer on your own computer is showing right now.
        </p>
        <DeviceLinkApproval initialCode={code} />
      </div>
    </main>
  );
}
