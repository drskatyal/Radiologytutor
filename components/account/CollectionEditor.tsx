"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button, Field, IconButton, Input, Modal, Textarea, useToast } from "@/components/ui";
import { api, errorText } from "@/lib/cloud/client";
import { LIMITS, type Collection } from "@/lib/cloud/types";

export function NewCollectionButton() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  const create = async () => {
    setBusy(true);
    try {
      const { collection } = await api<{ collection: Collection }>("/api/collections", { method: "POST", json: { name } });
      toast({ title: "Collection created", variant: "success" });
      router.push(`/collections/${collection.id}`);
    } catch (err) {
      toast({ title: "Could not create the collection", description: errorText(err), variant: "danger" });
      setBusy(false);
    }
  };
  return (
    <>
      <Button leadingIcon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setOpen(true)}>
        New collection
      </Button>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="New collection"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={create} loading={busy} disabled={!name.trim() || busy}>
              Create
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void create();
          }}
        >
          <Field label="Name">{(p) => <Input {...p} autoFocus maxLength={LIMITS.collectionName} value={name} onChange={(e) => setName(e.target.value)} placeholder="Chest unknowns, week 3" />}</Field>
        </form>
      </Modal>
    </>
  );
}

interface StudyRef {
  id: string;
  title: string;
  modality?: string;
}

export function CollectionEditor({ initial, studies }: { initial: Collection; studies: StudyRef[] }) {
  const [c, setC] = useState(initial);
  const [draft, setDraft] = useState({ name: initial.name, description: initial.description });
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  const byId = new Map(studies.map((s) => [s.id, s]));

  const patch = async (body: Partial<Collection>, ok: string) => {
    const before = c;
    setC((x) => ({ ...x, ...body }));
    try {
      const { collection } = await api<{ collection: Collection }>(`/api/collections/${c.id}`, { method: "PATCH", json: body });
      setC(collection);
      toast({ title: ok, variant: "success" });
    } catch (err) {
      setC(before);
      toast({ title: "Not saved", description: errorText(err), variant: "danger" });
    }
  };

  const move = (i: number, d: -1 | 1) => {
    const ids = [...c.studyIds];
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void patch({ studyIds: ids }, "Order saved");
  };

  return (
    <div className="space-y-6">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          await patch(draft, "Collection saved");
          setSaving(false);
        }}
      >
        <Field label="Name">{(p) => <Input {...p} maxLength={LIMITS.collectionName} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
        <Field label="Description">{(p) => <Textarea {...p} rows={3} maxLength={LIMITS.collectionDescription} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}</Field>
        <Button type="submit" loading={saving} disabled={saving || (draft.name === c.name && draft.description === c.description)}>
          Save
        </Button>
      </form>

      <section>
        <h2 className="text-sm font-semibold">Studies ({c.studyIds.length})</h2>
        {c.studyIds.length === 0 ? (
          <p className="mt-2 text-sm text-secondary">
            Add studies from a study’s page (More → Collections).{" "}
            <Link href="/library" className="font-semibold text-accent hover:underline">
              Open your studies
            </Link>
          </p>
        ) : (
          <ol className="mt-2 divide-y divide-subtle rounded-xl border border-subtle bg-surface">
            {c.studyIds.map((id, i) => {
              const s = byId.get(id);
              return (
                <li key={id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="w-6 text-right tabular-nums text-muted">{i + 1}</span>
                  {s ? (
                    <Link href={`/studies/${id}`} className="min-w-0 flex-1 truncate font-medium hover:text-accent">
                      {s.modality ? `${s.modality} · ` : ""}
                      {s.title}
                    </Link>
                  ) : (
                    <span className="flex-1 text-muted">Deleted study</span>
                  )}
                  <IconButton aria-label="Move up" title="Move up" size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp />
                  </IconButton>
                  <IconButton aria-label="Move down" title="Move down" size="sm" disabled={i === c.studyIds.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown />
                  </IconButton>
                  <IconButton aria-label="Remove from collection" title="Remove from collection" size="sm" onClick={() => patch({ studyIds: c.studyIds.filter((x) => x !== id) }, "Removed from collection")}>
                    <Trash2 />
                  </IconButton>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section>
        <Button variant="danger" size="sm" onClick={() => setConfirm(true)}>
          Delete collection
        </Button>
        <Modal
          open={confirm}
          onClose={() => setConfirm(false)}
          title="Delete this collection?"
          description="The studies stay in your library. Links to this collection stop working."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  try {
                    await api(`/api/collections/${c.id}`, { method: "DELETE" });
                    toast({ title: "Collection deleted", variant: "success" });
                    router.push("/collections");
                    router.refresh();
                  } catch (err) {
                    toast({ title: "Could not delete", description: errorText(err), variant: "danger" });
                  }
                }}
              >
                Delete collection
              </Button>
            </>
          }
        />
      </section>
    </div>
  );
}
