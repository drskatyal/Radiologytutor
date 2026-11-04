// Storage plans for FlowRad Viewer accounts.
//
// Viewing is always free and needs no account. A plan only limits how many
// studies an account keeps in the cloud (anonymised, stored, shareable).
// Prices are PLACEHOLDERS until billing is designed: the UI says so and
// nothing takes payment.

export type PlanId = "free" | "pro" | "super";

export interface Plan {
  id: PlanId;
  name: string;
  /** Studies an account may keep stored at once. */
  studyLimit: number;
  /** Placeholder monthly price in USD. Not charged anywhere. */
  placeholderMonthlyUsd: number;
  blurb: string;
  features: readonly string[];
}

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    studyLimit: 20,
    placeholderMonthlyUsd: 0,
    blurb: "Store and share a few teaching studies.",
    features: ["20 stored studies", "View-only share links", "Unknown or with-findings links", "Collections and embeds"],
  },
  {
    id: "pro",
    name: "Pro",
    studyLimit: 500,
    placeholderMonthlyUsd: 12,
    blurb: "A personal teaching file.",
    features: ["500 stored studies", "Everything in Free", "Downloads on shared links", "Link expiry and revoke"],
  },
  {
    id: "super",
    name: "Super",
    studyLimit: 2000,
    placeholderMonthlyUsd: 29,
    blurb: "A teaching file a department relies on.",
    features: ["2,000 stored studies", "Everything in Pro", "Priority support"],
  },
];

export function planById(id: string | null | undefined): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

export interface QuotaCheck {
  ok: boolean;
  used: number;
  limit: number;
  remaining: number;
}

/** Can an account on `planId` holding `used` studies add `adding` more? */
export function checkStudyQuota(planId: string | null | undefined, used: number, adding = 1): QuotaCheck {
  const limit = planById(planId).studyLimit;
  const safeUsed = Math.max(0, Math.floor(used));
  return {
    ok: safeUsed + adding <= limit,
    used: safeUsed,
    limit,
    remaining: Math.max(0, limit - safeUsed),
  };
}

export function formatPlaceholderPrice(plan: Plan): string {
  return plan.placeholderMonthlyUsd === 0 ? "$0" : `$${plan.placeholderMonthlyUsd}`;
}
