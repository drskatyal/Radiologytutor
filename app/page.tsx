import { getSession } from "@/lib/auth";
import { Landing } from "@/components/marketing/Landing";
import { LANDING_FAQ } from "@/components/marketing/faq";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "RadLearn",
  description:
    "Teach radiology on the DICOM study. Record a case once. Registrars replay it with an AI tutor that drives scroll, window, and zoom.",
  openGraph: {
    title: "RadLearn",
    description:
      "Teach radiology on the DICOM study. Record a case once. Registrars replay it with an AI tutor that drives scroll, window, and zoom.",
    type: "website",
  },
};

function canTeach(session: Awaited<ReturnType<typeof getSession>>): boolean {
  if (!session) return false;
  if (session.user.platformRole === "super_admin") return true;
  const role = session.user.membershipRole;
  return role === "author" || role === "admin" || role === "owner";
}

/**
 * Marketing landing. One offer: a teacher records a case, the tutor replays it.
 * The library lives at /library and does not borrow placeholder courses.
 */
export default async function HomePage() {
  const session = await getSession();
  const teachHref = canTeach(session) ? "/studio" : "/sign-up";
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: LANDING_FAQ.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <Landing teachHref={teachHref} />
    </>
  );
}
