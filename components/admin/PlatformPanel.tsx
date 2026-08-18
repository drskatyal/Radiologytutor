import { BadgeCheck, ScanSearch, ShieldCheck, Wallet } from "lucide-react";
import { Badge, Panel } from "@/components/ui";

/** Platform-admin surfaces on the roadmap — orientation, not invented behavior. */
export function PlatformPanel() {
  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 sm:grid-cols-2">
        <Panel
          title={
            <span className="inline-flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-accent" aria-hidden="true" />
              Org admin
            </span>
          }
        >
          <p className="text-sm font-semibold text-primary">Case oversight</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            Org admins and owners publish, unpublish, and delete teaching cases for their tenant.
            Auth will gate the Cases tab to membership role admin or higher.
          </p>
        </Panel>
        <Panel
          title={
            <span className="inline-flex items-center gap-2">
              <BadgeCheck className="h-4 w-4 text-accent" aria-hidden="true" />
              Super-admin
            </span>
          }
        >
          <p className="text-sm font-semibold text-primary">Platform operations</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            FlowRad staff (User.platformRole = super_admin) run teacher verification,
            de-identification review, and marketplace health. Labeled here; gated when sessions
            carry that role.
          </p>
        </Panel>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {TILES.map((t) => (
          <div
            key={t.title}
            className="flex flex-col gap-2 rounded-xl border border-dashed border-strong bg-surface/60 p-4 opacity-80"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-elevated text-muted">
                {t.icon}
              </span>
              <Badge variant="neutral">{t.badge}</Badge>
            </div>
            <p className="text-sm font-semibold text-primary">{t.title}</p>
            <p className="text-xs leading-relaxed text-muted">{t.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

const TILES = [
  {
    icon: <BadgeCheck className="h-5 w-5" aria-hidden="true" />,
    title: "Author verification",
    description: "Review credentials before authors can publish publicly.",
    badge: "Coming in P0",
  },
  {
    icon: <ScanSearch className="h-5 w-5" aria-hidden="true" />,
    title: "De-identification",
    description: "PHI review queue for uploaded studies.",
    badge: "Coming in P1",
  },
  {
    icon: <Wallet className="h-5 w-5" aria-hidden="true" />,
    title: "Payouts",
    description: "Marketplace earnings via the payments seam.",
    badge: "Coming in P3",
  },
];
