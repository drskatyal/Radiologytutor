// Plans: priced by how many studies an account keeps stored. Viewing is free
// and needs no account. Prices are placeholders until billing exists; nothing
// on this page takes payment.

import type { Metadata } from "next";
import Link from "next/link";
import { PLANS, formatPlaceholderPrice } from "@/lib/cloud/plans";

export const metadata: Metadata = {
  title: "Pricing · FlowRad Viewer",
  description: "The viewer is free. Plans set how many anonymised teaching studies you can store and share.",
  alternates: { canonical: "https://viewer.flowrad.ai/pricing" },
};

export default function PricingPage() {
  return (
    <main id="main" className="viewer-main">
      <section>
        <div className="w">
          <div className="eyebrow">Pricing</div>
          <h2>
            Viewing is free. <em>Storage is by the study.</em>
          </h2>
          <p className="sub">
            Open as many studies as you like in the web or desktop viewer, with no account. A plan sets how many
            anonymised studies you keep stored and shareable.
          </p>
          <span className="placeholder">Prices are placeholders. No plan is charged yet.</span>
          <div className="plans">
            {PLANS.map((plan, i) => (
              <article key={plan.id} className={i === 1 ? "card plan featured" : "card plan"}>
                <span className="badge">{plan.name}</span>
                <div className="amount">
                  {formatPlaceholderPrice(plan)}
                  <small> / month</small>
                </div>
                <p className="limit">{plan.studyLimit.toLocaleString("en-US")} stored studies</p>
                <p>{plan.blurb}</p>
                <ul>
                  {plan.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                {plan.id === "free" ? (
                  <Link className="b bp" href="/sign-in">
                    Start free
                  </Link>
                ) : (
                  <a className="b bo" href={`mailto:support@flowrad.ai?subject=FlowRad%20Viewer%20${plan.name}%20plan`}>
                    Ask about {plan.name}
                  </a>
                )}
              </article>
            ))}
          </div>
          <p className="fine">
            A stored study counts once, however many series or images it has. Deleting a study frees its place.
            Shared links are view-only and never count against the person you share with.
          </p>
        </div>
      </section>
    </main>
  );
}
