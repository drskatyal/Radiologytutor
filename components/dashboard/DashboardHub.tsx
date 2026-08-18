import Link from "next/link";
import { GraduationCap, LayoutGrid, PenLine, ShieldCheck } from "lucide-react";
import { Button, Card, PageContainer } from "@/components/ui";
import { PageHeader } from "@/components/AppShell";

/** Shown when signed in but org membership is not on the session yet. */
export function DashboardHub({ email, name }: { email?: string | null; name?: string | null }) {
  const who = name || email || "there";

  return (
    <>
      <PageHeader
        title={`Welcome, ${who}`}
        description="Pick a home. Role-based routing will use your org membership once it is on the session."
      />
      <PageContainer>
        <ul className="grid gap-4 sm:grid-cols-3">
          <HubLink
            href="/library"
            icon={<LayoutGrid className="h-4 w-4" aria-hidden="true" />}
            label="Library"
            detail="Student — courses, teachers, and cases."
          />
          <HubLink
            href="/studio"
            icon={<PenLine className="h-4 w-4" aria-hidden="true" />}
            label="Studio"
            detail="Teacher — my cases, courses, and recording."
          />
          <HubLink
            href="/admin"
            icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
            label="Admin"
            detail="Org admin or Super-admin — cases, teachers, platform."
          />
        </ul>
        <p className="mt-6">
          <Link href="/library#courses">
            <Button variant="ghost" leadingIcon={<GraduationCap className="h-4 w-4" aria-hidden="true" />}>
              Browse courses
            </Button>
          </Link>
        </p>
      </PageContainer>
    </>
  );
}

function HubLink({
  href,
  icon,
  label,
  detail,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  detail: string;
}) {
  return (
    <li>
      <Link href={href} className="block h-full">
        <Card interactive className="flex h-full flex-col gap-2">
          <span className="flex items-center gap-2 text-accent">
            {icon}
            <span className="font-display text-base font-semibold text-primary">{label}</span>
          </span>
          <span className="text-sm leading-relaxed text-muted">{detail}</span>
        </Card>
      </Link>
    </li>
  );
}
