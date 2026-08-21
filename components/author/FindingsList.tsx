"use client";

// The ordered list of finding cards with reordering. Supports both up/down
// buttons (on each card) and HTML5 drag-and-drop. Reorder is optimistic: the
// list reflows immediately (animated via FLIP-free CSS transitions on the
// cards) and the parent persists + rolls back on error.

import { useState } from "react";
import type { Finding } from "@/lib/types";
import { FindingCard } from "./FindingCard";

interface FindingsListProps {
  findings: Finding[];
  onSaveFinding: (findingId: string, patch: Partial<Finding>) => Promise<void>;
  onDeleteFinding: (findingId: string) => void;
  onMove: (findingId: string, dir: -1 | 1) => void;
  /** Commit a fully reordered id sequence. */
  onReorder: (orderedIds: string[]) => void;
  /** Preview a single finding in the student player. */
  onPreview?: (findingId: string) => void;
  /** Bubble per-finding unsaved-edit state up to the workspace guard. */
  onDirtyChange?: (findingId: string, dirty: boolean) => void;
}

export function FindingsList({
  findings,
  onSaveFinding,
  onDeleteFinding,
  onMove,
  onReorder,
  onPreview,
  onDirtyChange,
}: FindingsListProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  function handleDragEnter(targetId: string) {
    if (!dragId || targetId === dragId) {
      setOverId(targetId === dragId ? null : overId);
      return;
    }
    setOverId(targetId);
  }

  function handleDragEnd() {
    if (dragId && overId && dragId !== overId) {
      const ids = findings.map((f) => f.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(overId);
      if (from !== -1 && to !== -1) {
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        onReorder(ids);
      }
    }
    setDragId(null);
    setOverId(null);
  }

  return (
    <ol className="space-y-3">
      {findings.map((f, i) => (
        <li key={f.id}>
          <FindingCard
            finding={f}
            index={i}
            total={findings.length}
            onSave={onSaveFinding}
            onDelete={onDeleteFinding}
            onMove={onMove}
            onPreview={onPreview}
            onDirtyChange={onDirtyChange}
            dragging={dragId === f.id}
            dropTarget={overId === f.id && dragId !== f.id}
            onDragStart={() => setDragId(f.id)}
            onDragEnter={() => handleDragEnter(f.id)}
            onDragEnd={handleDragEnd}
          />
        </li>
      ))}
    </ol>
  );
}
