"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Eye, GraduationCap, LayoutGrid, List, Plus, Search } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Input,
  PageContainer,
} from "@/components/ui";
import { caseTeachHref, caseViewHref } from "@/lib/caseShare";
import type { CaseStatus } from "@/lib/types";
import { ShareLinkControls } from "./ShareLinkControls";

export interface LockerCase {
  caseId: string;
  title: string;
  modality: string;
  status: CaseStatus;
  updatedAt?: string;
  studyCount: number;
  hasPack: boolean;
  sharePath: string | null;
}

function formatUpdated(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function CaseLocker({
  cases,
  canManageShare,
  addCaseHref,
}: {
  cases: LockerCase[];
  canManageShare: boolean;
  addCaseHref?: string;
}) {
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<"grid" | "list">("grid");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cases;
    return cases.filter((item) =>
      [item.title, item.modality, item.caseId].join(" ").toLowerCase().includes(q)
    );
  }, [cases, query]);

  if (cases.length === 0) {
    return (
      <PageContainer>
        <EmptyState
          icon={<Search aria-hidden="true" />}
          title={canManageShare ? "The locker is empty" : "No cases in the library yet"}
          description={
            canManageShare
              ? "Upload a study in Studio. It shows up here for viewing and sharing before anyone teaches it."
              : "Published studies will show up here. A teacher can also send you a share link."
          }
          action={
            addCaseHref ? (
              <Link href={addCaseHref}>
                <Button leadingIcon={<Plus className="h-4 w-4" aria-hidden="true" />}>Add a case</Button>
              </Link>
            ) : undefined
          }
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[16rem] flex-1">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title or modality"
            aria-label="Search cases"
            type="search"
          />
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Library layout">
          <IconButton
            type="button"
            aria-label="Grid layout"
            aria-pressed={layout === "grid"}
            size="md"
            variant={layout === "grid" ? "primary" : "secondary"}
            onClick={() => setLayout("grid")}
          >
            <LayoutGrid className="h-4 w-4" />
          </IconButton>
          <IconButton
            type="button"
            aria-label="List layout"
            aria-pressed={layout === "list"}
            size="md"
            variant={layout === "list" ? "primary" : "secondary"}
            onClick={() => setLayout("list")}
          >
            <List className="h-4 w-4" />
          </IconButton>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="No cases match"
          description="Try a different title or modality."
          action={
            <Button variant="secondary" onClick={() => setQuery("")}>
              Clear search
            </Button>
          }
        />
      ) : layout === "grid" ? (
        <ul className="grid list-none gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((item) => (
            <li key={item.caseId}>
              <CaseCard item={item} canManageShare={canManageShare} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="flex list-none flex-col gap-3">
          {visible.map((item) => (
            <li key={item.caseId}>
              <CaseRow item={item} canManageShare={canManageShare} />
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}

function Meta({ item }: { item: LockerCase }) {
  const when = formatUpdated(item.updatedAt);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="neutral">{item.modality || "Study"}</Badge>
      <Badge variant={item.status === "published" ? "success" : "warning"}>{item.status}</Badge>
      <Badge variant="neutral" className="tabular-nums">
        {item.studyCount} {item.studyCount === 1 ? "study" : "studies"}
      </Badge>
      {item.hasPack ? <Badge variant="accent">Teach pack</Badge> : null}
      {when ? <span className="text-xs text-muted tabular-nums">{when}</span> : null}
    </div>
  );
}

function Actions({ item, canManageShare }: { item: LockerCase; canManageShare: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Link href={caseViewHref(item.caseId)}>
        <Button size="sm" leadingIcon={<Eye className="h-3.5 w-3.5" aria-hidden="true" />}>
          View
        </Button>
      </Link>
      {item.hasPack ? (
        <Link href={caseTeachHref(item.caseId)}>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            Teach
          </Button>
        </Link>
      ) : null}
      {canManageShare ? (
        <ShareLinkControls caseId={item.caseId} initialPath={item.sharePath} />
      ) : null}
    </div>
  );
}

function CaseCard({ item, canManageShare }: { item: LockerCase; canManageShare: boolean }) {
  return (
    <Card className="flex h-full flex-col gap-3">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-primary">{item.title}</h2>
        <p className="mt-1 truncate font-mono text-xs text-muted">{item.caseId}</p>
      </div>
      <Meta item={item} />
      <div className="mt-auto pt-1">
        <Actions item={item} canManageShare={canManageShare} />
      </div>
    </Card>
  );
}

function CaseRow({ item, canManageShare }: { item: LockerCase; canManageShare: boolean }) {
  return (
    <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-primary">{item.title}</h2>
        <div className="mt-2">
          <Meta item={item} />
        </div>
      </div>
      <Actions item={item} canManageShare={canManageShare} />
    </Card>
  );
}
