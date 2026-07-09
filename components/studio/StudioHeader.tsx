"use client";

// The Studio hub header: title + description, a persistent "Create a case"
// action (the SAME entry point on every tab — CLAUDE.md create-case pathway),
// and the My cases / Courses & playlists / Profile tab row. Shared by the
// three hub pages so Studio always reads as one coherent home.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { GraduationCap, LayoutGrid, Plus, UserRound } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Button, Tabs } from "@/components/ui";

export type StudioTab = "cases" | "courses" | "profile";

const TABS: { value: StudioTab; label: string; href: string; icon: React.ReactNode }[] = [
  { value: "cases", label: "My cases", href: "/studio/cases", icon: <LayoutGrid className="h-4 w-4" /> },
  {
    value: "courses",
    label: "Courses & playlists",
    href: "/studio/courses",
    icon: <GraduationCap className="h-4 w-4" />,
  },
  { value: "profile", label: "Profile", href: "/studio/profile", icon: <UserRound className="h-4 w-4" /> },
];

export function StudioHeader({ active }: { active: StudioTab }) {
  const router = useRouter();

  return (
    <PageHeader
      title="Studio"
      description="Create, refine and publish your teaching cases."
      actions={
        <Link href="/studio/new">
          <Button leadingIcon={<Plus className="h-4 w-4" aria-hidden="true" />}>Create a case</Button>
        </Link>
      }
    >
      <Tabs
        variant="underline"
        value={active}
        onValueChange={(v) => {
          const tab = TABS.find((t) => t.value === v);
          if (tab) router.push(tab.href);
        }}
        items={TABS.map(({ value, label, icon }) => ({ value, label, icon }))}
      />
    </PageHeader>
  );
}
