import type { Metadata } from "next";
import Link from "next/link";
import { AccountShell, requirePageAccount } from "@/components/account/AccountShell";
import { Badge, PageContainer, Panel, ProgressBar, SectionHeading } from "@/components/ui";
import { PLANS, checkStudyQuota, formatPlaceholderPrice, planById } from "@/lib/cloud/plans";

export const metadata: Metadata = { title: "Account · FlowRad Viewer" };
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const ctx = await requirePageAccount("/account");
  const plan = planById(ctx.account.plan);
  const quota = checkStudyQuota(plan.id, ctx.used, 0);
  return (
    <AccountShell ctx={ctx}>
      <PageContainer width="narrow">
        <SectionHeading title={<span className="font-display text-4xl font-medium">Account</span>} description={ctx.user.email} />
        <Panel className="mt-6" title="Plan">
          <div className="flex items-center gap-3">
            <Badge variant="accent">{plan.name}</Badge>
            <span className="text-sm tabular-nums text-secondary">
              {quota.used} of {quota.limit.toLocaleString("en-US")} stored studies
            </span>
          </div>
          <ProgressBar className="mt-3" value={quota.used / quota.limit} label="Stored studies" valueText={`${quota.used} of ${quota.limit}`} />
          <ul className="mt-5 grid gap-3 sm:grid-cols-3">
            {PLANS.map((p) => (
              <li key={p.id} className={p.id === plan.id ? "rounded-lg border-2 border-accent p-3" : "rounded-lg border border-subtle p-3"}>
                <p className="font-semibold">{p.name}</p>
                <p className="text-xs tabular-nums text-secondary">
                  {p.studyLimit.toLocaleString("en-US")} studies · {formatPlaceholderPrice(p)}/mo*
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">
            *Placeholder prices. Plans are not billed yet. To move to Pro or Super, email{" "}
            <a className="font-semibold text-accent hover:underline" href="mailto:support@flowrad.ai?subject=FlowRad%20Viewer%20plan">
              support@flowrad.ai
            </a>
            . <Link className="font-semibold text-accent hover:underline" href="/pricing">Compare plans</Link>
          </p>
        </Panel>
        <Panel className="mt-6" title="Privacy">
          <p className="text-sm text-secondary">
            Studies are anonymised in your browser before upload, and the server refuses any file that still carries patient
            identifiers. Burned-in text in pixels is not detected: check images before storing them. Deleting a study removes
            its images from storage and revokes its links.
          </p>
        </Panel>
      </PageContainer>
    </AccountShell>
  );
}
