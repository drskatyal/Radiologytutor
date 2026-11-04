// Chrome for the signed-in pages (library, study, collections, account):
// lockup, section nav, plan usage, sign out. Pages render inside it.

import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, ensureAccount } from "@/lib/cloud/auth";
import { checkStudyQuota, planById } from "@/lib/cloud/plans";
import { viewerStore } from "@/lib/cloud/store";
import type { Account } from "@/lib/cloud/types";
import type { SessionUser } from "@/lib/cloud/session";
import { AccountNav } from "./AccountNav";
import { SignOutButton } from "./SignOutButton";

export interface AccountContext {
  user: SessionUser;
  account: Account;
  used: number;
}

/** Server pages: the signed-in user, or a redirect to sign-in. */
export async function requirePageAccount(next: string): Promise<AccountContext> {
  const user = currentUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  const account = await ensureAccount(user);
  const used = (await viewerStore().listStudies(user.id)).length;
  return { user, account, used };
}

export function AccountShell({ ctx, children }: { ctx: AccountContext; children: React.ReactNode }) {
  const plan = planById(ctx.account.plan);
  const quota = checkStudyQuota(plan.id, ctx.used, 0);
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-30 border-b border-subtle bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-8">
          <Link href="/" aria-label="FlowRad Viewer home" className="flex shrink-0 items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <Image src="/brand/flowrad-lockup.svg" alt="FlowRad" width={105} height={28} unoptimized className="h-7 w-auto" />
            <span className="hidden text-sm font-semibold text-secondary sm:inline">Viewer</span>
          </Link>
          <AccountNav />
          <div className="ml-auto flex items-center gap-3">
            <Link
              href="/account"
              className="hidden rounded-lg px-2 py-1 text-right text-xs leading-tight text-secondary hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:block"
            >
              <span className="block font-semibold text-primary">{plan.name} plan</span>
              <span className="tabular-nums">
                {quota.used} of {quota.limit.toLocaleString("en-US")} studies
              </span>
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-subtle py-6 text-center text-xs text-muted">
        FlowRad Viewer is for education and research. Not for diagnostic use. ·{" "}
        <Link className="underline-offset-2 hover:underline" href="/pricing">
          Plans
        </Link>
      </footer>
    </div>
  );
}
