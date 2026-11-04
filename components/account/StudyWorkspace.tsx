"use client";

// One stored study: the viewer, its teaching write-up (history, findings,
// diagnosis, tags), markup, share links, collections, download and delete.
// Saves are optimistic with rollback and a toast either way.

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, PenLine, Save, Trash2, X } from "lucide-react";
import { Badge, Button, Field, Input, Modal, Panel, Tabs, Textarea, useToast } from "@/components/ui";
import { RemoteStudyViewer } from "./RemoteStudyViewer";
import { SharePanel } from "./SharePanel";
import { api, errorText } from "@/lib/cloud/client";
import { LIMITS, normalizeTags, type MarkupItem, type Study } from "@/lib/cloud/types";
import type { Share } from "@/lib/cloud/shares";

interface CollectionRef {
  id: string;
  name: string;
  hasStudy: boolean;
}

export function StudyWorkspace({ initialStudy, initialShares, collections: initialCollections }: { initialStudy: Study; initialShares: Share[]; collections: CollectionRef[] }) {
  const [study, setStudy] = useState(initialStudy);
  const [draft, setDraft] = useState({
    title: study.title,
    history: study.history,
    findings: study.findings,
    diagnosis: study.diagnosis,
    tags: study.tags.join(", "),
  });
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<MarkupItem[]>([]);
  const [savingMarkup, setSavingMarkup] = useState(false);
  const [collections, setCollections] = useState(initialCollections);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  const dirty =
    draft.title !== study.title ||
    draft.history !== study.history ||
    draft.findings !== study.findings ||
    draft.diagnosis !== study.diagnosis ||
    normalizeTags(draft.tags.split(",")).join(",") !== study.tags.join(",");

  const patch = useCallback(
    async (body: Partial<Study>, okTitle: string) => {
      const before = study;
      setStudy((s) => ({ ...s, ...body }));
      try {
        const { study: saved } = await api<{ study: Study }>(`/api/studies/${study.id}`, { method: "PATCH", json: body });
        setStudy(saved);
        toast({ title: okTitle, variant: "success" });
        return saved;
      } catch (err) {
        setStudy(before);
        toast({ title: "Not saved", description: errorText(err), variant: "danger" });
        return null;
      }
    },
    [study, toast]
  );

  const saveText = async () => {
    setSaving(true);
    const saved = await patch(
      { title: draft.title, history: draft.history, findings: draft.findings, diagnosis: draft.diagnosis, tags: normalizeTags(draft.tags.split(",")) },
      "Study saved"
    );
    if (saved) setDraft((d) => ({ ...d, title: saved.title, tags: saved.tags.join(", ") }));
    setSaving(false);
  };

  const onStroke = useCallback((item: MarkupItem) => {
    setPending((p) => {
      // A stroke edited in place reports again with the same annotation UID.
      const uid = item.annotation.annotationUID;
      const rest = uid ? p.filter((x) => x.annotation.annotationUID !== uid) : p;
      return [...rest, item];
    });
  }, []);

  const saveMarkup = async () => {
    setSavingMarkup(true);
    const saved = await patch({ markup: [...study.markup, ...pending].slice(0, LIMITS.markup) }, "Markup saved");
    if (saved) setPending([]);
    setSavingMarkup(false);
  };

  const toggleCollection = async (c: CollectionRef) => {
    const before = collections;
    setCollections((cs) => cs.map((x) => (x.id === c.id ? { ...x, hasStudy: !x.hasStudy } : x)));
    try {
      const { collection } = await api<{ collection: { studyIds: string[] } }>(`/api/collections/${c.id}`);
      const ids = c.hasStudy ? collection.studyIds.filter((id) => id !== study.id) : [...collection.studyIds, study.id];
      await api(`/api/collections/${c.id}`, { method: "PATCH", json: { studyIds: ids } });
      toast({ title: c.hasStudy ? `Removed from ${c.name}` : `Added to ${c.name}`, variant: "success" });
    } catch (err) {
      setCollections(before);
      toast({ title: "Collection not updated", description: errorText(err), variant: "danger" });
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api(`/api/studies/${study.id}`, { method: "DELETE" });
      toast({ title: "Study deleted", description: "Its share links no longer work.", variant: "success" });
      router.push("/library");
      router.refresh();
    } catch (err) {
      setDeleting(false);
      toast({ title: "Could not delete", description: errorText(err), variant: "danger" });
    }
  };

  const [tab, setTab] = useState("case");
  const renderTabs = (panels: { id: string; label: string; content: React.ReactNode }[]) => (
    <>
      <Tabs items={panels.map((p) => ({ value: p.id, label: p.label }))} value={tab} onValueChange={setTab} variant="underline" className="mb-4" />
      {panels.find((p) => p.id === tab)?.content}
    </>
  );

  const ready = study.status === "ready";
  const viewer = useMemo(
    () => (
      <RemoteStudyViewer
        wadoRsRoot="/api/dicomweb"
        studyInstanceUID={study.studyInstanceUID}
        series={study.series}
        markup={study.markup}
        onStroke={onStroke}
        className="h-[62dvh] min-h-[420px]"
      />
    ),
    // Re-mount only when the saved markup or series change, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [study.studyInstanceUID, study.series, study.markup, onStroke]
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/library" className="inline-flex items-center gap-1 rounded text-sm font-medium text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Studies
        </Link>
        {study.modality && <Badge variant="accent">{study.modality}</Badge>}
        {!ready && <Badge variant="warning">Upload incomplete: store it again to finish</Badge>}
        <span className="text-xs tabular-nums text-muted">
          {study.series.length} series · {study.instanceCount} images
        </span>
      </div>
      <h1 className="mt-2 font-display text-4xl font-medium tracking-tight">{study.title}</h1>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-3">
          {viewer}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <PenLine className="h-4 w-4 text-muted" aria-hidden />
            <span className="text-secondary">
              {study.markup.length} saved markup item{study.markup.length === 1 ? "" : "s"}
              {pending.length > 0 && ` · ${pending.length} new`}
            </span>
            <Button size="sm" onClick={saveMarkup} loading={savingMarkup} disabled={!pending.length || savingMarkup} leadingIcon={<Save className="h-4 w-4" aria-hidden />}>
              Save markup
            </Button>
            {study.markup.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => patch({ markup: [] }, "Markup cleared")} leadingIcon={<X className="h-4 w-4" aria-hidden />}>
                Clear saved markup
              </Button>
            )}
          </div>
          <p className="text-xs text-muted">Draw arrows and measurements in the viewer, then save them. They show on links shared with findings.</p>
        </div>

        <Panel className="h-fit">
          {renderTabs([
              {
                id: "case",
                label: "Case",
                content: (
                  <form
                    className="space-y-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveText();
                    }}
                  >
                    <Field label="Title">{(p) => <Input {...p} maxLength={LIMITS.title} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />}</Field>
                    <Field label="Clinical history" hint="Shown on every link, including unknowns.">
                      {(p) => <Textarea {...p} rows={3} maxLength={LIMITS.history} value={draft.history} onChange={(e) => setDraft({ ...draft, history: e.target.value })} />}
                    </Field>
                    <Field label="Findings">
                      {(p) => <Textarea {...p} rows={5} maxLength={LIMITS.findings} value={draft.findings} onChange={(e) => setDraft({ ...draft, findings: e.target.value })} />}
                    </Field>
                    <Field label="Diagnosis">
                      {(p) => <Input {...p} maxLength={LIMITS.diagnosis} value={draft.diagnosis} onChange={(e) => setDraft({ ...draft, diagnosis: e.target.value })} />}
                    </Field>
                    <Field label="Tags" hint="Comma separated, e.g. chest, ct, nodule">
                      {(p) => <Input {...p} value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />}
                    </Field>
                    <p className="text-xs text-muted">Write no patient identifiers here: this text is shared with the study.</p>
                    <Button type="submit" loading={saving} disabled={!dirty || saving} data-testid="save-study">
                      Save
                    </Button>
                  </form>
                ),
              },
              {
                id: "share",
                label: "Share",
                content: <SharePanel target={{ studyId: study.id }} initialShares={initialShares} disabledReason={ready ? undefined : "Finish the upload before sharing."} />,
              },
              {
                id: "more",
                label: "More",
                content: (
                  <div className="space-y-5 text-sm">
                    <section>
                      <h2 className="font-semibold">Collections</h2>
                      {collections.length === 0 ? (
                        <p className="mt-1 text-secondary">
                          No collections yet.{" "}
                          <Link href="/collections" className="font-semibold text-accent hover:underline">
                            Create one
                          </Link>
                        </p>
                      ) : (
                        <ul className="mt-2 space-y-2">
                          {collections.map((c) => (
                            <li key={c.id}>
                              <label className="flex items-center gap-3">
                                <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={c.hasStudy} onChange={() => toggleCollection(c)} />
                                {c.name}
                              </label>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                    <section>
                      <h2 className="font-semibold">Download</h2>
                      <p className="mt-1 text-secondary">The anonymised DICOM, as a ZIP.</p>
                      {ready ? (
                        <a href={`/api/studies/${study.id}/download`} className="mt-2 inline-flex items-center gap-2 rounded-lg border border-strong bg-elevated px-3 py-2 font-medium hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                          <Download className="h-4 w-4" aria-hidden /> Download ZIP
                        </a>
                      ) : (
                        <p className="mt-2 text-xs text-warning">Available once the upload finishes.</p>
                      )}
                    </section>
                    <section>
                      <h2 className="font-semibold">Teaching and quiz modes</h2>
                      <p className="mt-1 text-secondary">Planned: step-through teaching and self-test quizzes built from your findings and markup.</p>
                    </section>
                    <section>
                      <h2 className="font-semibold text-danger">Delete study</h2>
                      <p className="mt-1 text-secondary">Removes the images from storage and revokes every link to it.</p>
                      <Button className="mt-2" variant="danger" size="sm" onClick={() => setConfirmDelete(true)} leadingIcon={<Trash2 className="h-4 w-4" aria-hidden />}>
                        Delete study
                      </Button>
                    </section>
                  </div>
                ),
              },
          ])}
        </Panel>
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
        title="Delete this study?"
        description="The anonymised images are removed from storage and every share link stops working. This cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} loading={deleting} data-testid="confirm-delete">
              Delete study
            </Button>
          </>
        }
      />
    </div>
  );
}
