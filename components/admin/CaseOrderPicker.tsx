"use client";

// Pick + order cases for a course/playlist. Left: available cases (searchable,
// click to add). Right: the ordered selection (move up/down, remove). Order is
// significant — it's the sequence learners follow.

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Search, X } from "lucide-react";
import { Badge, IconButton, Input } from "@/components/ui";
import type { AdminCaseRow } from "./types";

export function CaseOrderPicker({
  cases,
  caseTitleById,
  selected,
  onChange,
}: {
  cases: AdminCaseRow[];
  caseTitleById: Record<string, string>;
  selected: string[];
  onChange: (caseIds: string[]) => void;
}) {
  const [q, setQ] = useState("");

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const available = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cases
      .filter((c) => !selectedSet.has(c.caseId))
      .filter((c) => (needle ? c.title.toLowerCase().includes(needle) : true));
  }, [cases, selectedSet, q]);

  function add(id: string) {
    onChange([...selected, id]);
  }
  function removeAt(i: number) {
    onChange(selected.filter((_, idx) => idx !== i));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= selected.length) return;
    const next = selected.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-primary">Cases</h3>
        <Badge variant="neutral" className="tabular-nums">
          {selected.length} selected
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* Available */}
        <div className="flex flex-col gap-2 rounded-lg border border-subtle bg-surface/50 p-2">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
            />
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search cases…"
              aria-label="Search available cases"
              className="h-9 pl-8 text-sm"
            />
          </div>
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
            {available.length === 0 ? (
              <li className="px-2 py-6 text-center text-xs text-muted">
                {cases.length === 0 ? "No cases exist yet." : "No matching cases."}
              </li>
            ) : (
              available.map((c) => (
                <li key={c.caseId}>
                  <button
                    type="button"
                    onClick={() => add(c.caseId)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-secondary transition-colors hover:bg-overlay hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    <Plus className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="shrink-0 text-xs text-muted">{c.modality}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>

        {/* Selected (ordered) */}
        <div className="flex flex-col gap-2 rounded-lg border border-subtle bg-surface/50 p-2">
          <span className="px-1 text-xs font-medium uppercase tracking-wide text-muted">
            In order
          </span>
          {selected.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted">
              Add cases from the left. Order is the sequence learners follow.
            </p>
          ) : (
            <ol className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {selected.map((id, i) => (
                <li
                  key={id}
                  className="flex items-center gap-2 rounded-md border border-subtle bg-elevated px-2 py-1.5"
                >
                  <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-primary">
                    {caseTitleById[id] ?? id}
                  </span>
                  <IconButton
                    aria-label="Move up"
                    size="sm"
                    variant="ghost"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    aria-label="Move down"
                    size="sm"
                    variant="ghost"
                    disabled={i === selected.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    aria-label="Remove case"
                    size="sm"
                    variant="ghost"
                    onClick={() => removeAt(i)}
                  >
                    <X className="h-3.5 w-3.5 text-danger" />
                  </IconButton>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
