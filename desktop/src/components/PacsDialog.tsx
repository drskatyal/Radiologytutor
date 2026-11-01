// Query / retrieve from a PACS: DICOMweb (QIDO-RS + WADO-RS) or DIMSE
// (C-FIND + C-MOVE). Retrieval lands in the app cache and opens through the
// normal local pipeline. Opt-in: nothing here runs until a node is added.
//
// Node settings persist; passwords and tokens are kept in memory for the
// session only, never written to disk.

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Network, Plus, Search, Trash2, XCircle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "../toast";
import { cn } from "@/components/ui/cn";
import { invoke, listen, settingsGet, settingsSet } from "../platform";
import { formatDicomDate, formatPersonName } from "../study";

export type PacsNodeConfig =
  | { id: string; name: string; kind: "dicomweb"; url: string; username?: string }
  | { id: string; name: string; kind: "dimse"; host: string; port: number; calledAe: string; callingAe: string; localPort: number };

interface StudyRow {
  studyInstanceUID: string;
  patientName?: string;
  patientId?: string;
  patientBirthDate?: string;
  studyDate?: string;
  studyTime?: string;
  studyDescription?: string;
  accessionNumber?: string;
  modalities: string[];
  seriesCount?: number;
  instanceCount?: number;
}

/** In-memory only: credentials never touch disk. */
const secrets = new Map<string, { password?: string; token?: string }>();

function toWire(node: PacsNodeConfig) {
  if (node.kind === "dimse") {
    return { kind: "dimse", host: node.host, port: node.port, calledAe: node.calledAe, callingAe: node.callingAe, localPort: node.localPort };
  }
  const s = secrets.get(node.id) ?? {};
  return { kind: "dicomweb", url: node.url, username: node.username || null, password: s.password ?? null, token: s.token ?? null };
}

function dateRange(preset: string): string | undefined {
  const fmt = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const today = new Date();
  const back = (days: number) => new Date(today.getTime() - days * 86400000);
  if (preset === "today") return fmt(today);
  if (preset === "7") return `${fmt(back(7))}-${fmt(today)}`;
  if (preset === "30") return `${fmt(back(30))}-${fmt(today)}`;
  if (preset === "365") return `${fmt(back(365))}-${fmt(today)}`;
  return undefined;
}

const SELECT = "h-9 rounded-lg border border-strong bg-elevated px-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function PacsDialog({ open, onClose, onRetrieved }: { open: boolean; onClose: () => void; onRetrieved: (folder: string, label: string) => void }) {
  const { toast } = useToast();
  const [nodes, setNodes] = useState<PacsNodeConfig[]>([]);
  const [nodeId, setNodeId] = useState<string>("");
  const [editing, setEditing] = useState<PacsNodeConfig | null>(null);
  const [secret, setSecret] = useState("");
  const [echo, setEcho] = useState<"idle" | "busy" | "ok" | string>("idle");
  const [query, setQuery] = useState({ patientName: "", patientId: "", date: "any", modality: "", accessionNumber: "" });
  const [rows, setRows] = useState<StudyRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [retrieving, setRetrieving] = useState<{ uid: string; received: number; total?: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    settingsGet<{ pacsNodes?: PacsNodeConfig[] }>().then((s) => {
      const list = s.pacsNodes ?? [];
      setNodes(list);
      setNodeId((id) => id || list[0]?.id || "");
      if (list.length === 0) setEditing(blankWeb());
    });
  }, [open]);

  const node = useMemo(() => nodes.find((n) => n.id === nodeId) ?? null, [nodes, nodeId]);

  const persist = async (list: PacsNodeConfig[]) => {
    setNodes(list);
    await settingsSet({ pacsNodes: list });
  };

  const blankWeb = (): PacsNodeConfig => ({ id: crypto.randomUUID(), name: "", kind: "dicomweb", url: "", username: "" });
  const blankDimse = (): PacsNodeConfig => ({ id: crypto.randomUUID(), name: "", kind: "dimse", host: "", port: 104, calledAe: "", callingAe: "RADLEARN", localPort: 11112 });

  const saveEditing = async () => {
    if (!editing) return;
    const valid = editing.kind === "dicomweb" ? /^https?:\/\//.test(editing.url) : !!editing.host && !!editing.calledAe && !!editing.callingAe;
    if (!valid) {
      toast({ title: "Fill in the connection details", variant: "warning" });
      return;
    }
    const named = { ...editing, name: editing.name.trim() || (editing.kind === "dicomweb" ? new URL(editing.url).host : `${editing.calledAe}@${editing.host}`) } as PacsNodeConfig;
    if (named.kind === "dicomweb") secrets.set(named.id, secret ? (named.username ? { password: secret } : { token: secret }) : {});
    const list = nodes.some((n) => n.id === named.id) ? nodes.map((n) => (n.id === named.id ? named : n)) : [...nodes, named];
    await persist(list);
    setNodeId(named.id);
    setEditing(null);
    setSecret("");
  };

  const runEcho = async (target: PacsNodeConfig) => {
    setEcho("busy");
    try {
      await invoke("pacs_echo", { node: toWire(target) });
      setEcho("ok");
    } catch (e) {
      setEcho(String(e));
    }
  };

  const search = async () => {
    if (!node) return;
    setSearching(true);
    setRows(null);
    try {
      const found = await invoke<StudyRow[]>("pacs_find", {
        node: toWire(node),
        query: {
          patientName: query.patientName || null,
          patientId: query.patientId || null,
          studyDate: dateRange(query.date) ?? null,
          modality: query.modality || null,
          accessionNumber: query.accessionNumber || null,
        },
      });
      found.sort((a, b) => (b.studyDate ?? "").localeCompare(a.studyDate ?? ""));
      setRows(found);
    } catch (e) {
      toast({ title: "The PACS query failed", description: String(e), variant: "danger", duration: 8000 });
    } finally {
      setSearching(false);
    }
  };

  const retrieve = async (row: StudyRow) => {
    if (!node || retrieving) return;
    setRetrieving({ uid: row.studyInstanceUID, received: 0, total: row.instanceCount });
    const off = await listen<{ received: number; total?: number }>("pacs-progress", (p) =>
      setRetrieving((r) => (r ? { ...r, received: p.received, total: p.total ?? r.total } : r))
    );
    try {
      const folder = await invoke<string>("pacs_retrieve", { node: toWire(node), studyUid: row.studyInstanceUID });
      onRetrieved(folder, row.studyDescription || "PACS study");
      onClose();
    } catch (e) {
      toast({ title: "Retrieve failed", description: String(e), variant: "danger", duration: 10000 });
    } finally {
      off();
      setRetrieving(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="PACS" description="Query and retrieve from a PACS. Studies are copied to this computer and open like a local folder." size="2xl">
      <div className="flex max-h-[68vh] flex-col gap-4 overflow-y-auto pr-1 text-sm">
        {editing ? (
          <section className="flex flex-col gap-3 rounded-lg border border-subtle bg-surface p-3">
            <div role="radiogroup" aria-label="Protocol" className="flex gap-2">
              {(["dicomweb", "dimse"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={editing.kind === k}
                  onClick={() => setEditing({ ...(k === "dicomweb" ? blankWeb() : blankDimse()), id: editing.id, name: editing.name })}
                  className={cn("rounded-md border px-3 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent", editing.kind === k ? "border-accent bg-accent-muted/40 text-primary" : "border-subtle text-secondary hover:border-strong")}
                >
                  {k === "dicomweb" ? "DICOMweb" : "DIMSE (C-FIND / C-MOVE)"}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">{(f) => <Input {...f} value={editing.name} placeholder="Hospital PACS" onChange={(e) => setEditing({ ...editing, name: e.target.value })} />}</Field>
              {editing.kind === "dicomweb" ? (
                <>
                  <Field label="DICOMweb root URL" hint="Google Cloud Healthcare: https://healthcare.googleapis.com/v1/projects/…/locations/…/datasets/…/dicomStores/…/dicomWeb, with a bearer token from gcloud auth print-access-token.">{(f) => <Input {...f} value={editing.url} placeholder="https://pacs.example.org/dicom-web" onChange={(e) => setEditing({ ...editing, url: e.target.value.trim() })} />}</Field>
                  <Field label="Username (optional)">{(f) => <Input {...f} value={editing.username ?? ""} onChange={(e) => setEditing({ ...editing, username: e.target.value })} />}</Field>
                  <Field label={editing.username ? "Password" : "Bearer token (optional)"} hint="Kept in memory for this session only.">
                    {(f) => <Input {...f} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />}
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Host">{(f) => <Input {...f} value={editing.host} placeholder="pacs.hospital.local" onChange={(e) => setEditing({ ...editing, host: e.target.value.trim() })} />}</Field>
                  <Field label="Port">{(f) => <Input {...f} inputMode="numeric" value={String(editing.port)} onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) || 104 })} />}</Field>
                  <Field label="PACS AE title (called)">{(f) => <Input {...f} value={editing.calledAe} onChange={(e) => setEditing({ ...editing, calledAe: e.target.value.trim().toUpperCase() })} />}</Field>
                  <Field label="This viewer's AE title (calling)">{(f) => <Input {...f} value={editing.callingAe} onChange={(e) => setEditing({ ...editing, callingAe: e.target.value.trim().toUpperCase() })} />}</Field>
                  <Field label="Local port for C-MOVE" hint="The PACS must have this AE title, this computer's address and this port configured.">
                    {(f) => <Input {...f} inputMode="numeric" value={String(editing.localPort)} onChange={(e) => setEditing({ ...editing, localPort: Number(e.target.value) || 11112 })} />}
                  </Field>
                </>
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              {nodes.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              )}
              <Button size="sm" onClick={saveEditing}>
                Save connection
              </Button>
            </div>
          </section>
        ) : (
          <section className="flex flex-wrap items-center gap-2">
            <Network className="h-4 w-4 text-secondary" aria-hidden />
            <select aria-label="PACS" value={nodeId} onChange={(e) => { setNodeId(e.target.value); setEcho("idle"); setRows(null); }} className={SELECT}>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name} · {n.kind === "dicomweb" ? "DICOMweb" : "DIMSE"}
                </option>
              ))}
            </select>
            <Button size="sm" variant="secondary" disabled={!node || echo === "busy"} onClick={() => node && runEcho(node)}>
              Test connection
            </Button>
            {echo === "busy" && <Spinner size="sm" label="Testing" />}
            {echo === "ok" && <span className="flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Connected</span>}
            {echo !== "idle" && echo !== "busy" && echo !== "ok" && (
              <span className="flex max-w-[360px] items-center gap-1 truncate text-xs text-danger" title={echo}><XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden /> {echo}</span>
            )}
            <span className="ml-auto flex gap-1">
              {node && <Button size="sm" variant="ghost" onClick={() => setEditing(node)}>Edit</Button>}
              {node && (
                <IconButton aria-label="Remove this PACS" size="sm" variant="danger" onClick={async () => { await persist(nodes.filter((n) => n.id !== node.id)); setNodeId(nodes.find((n) => n.id !== node.id)?.id ?? ""); }}>
                  <Trash2 />
                </IconButton>
              )}
              <Button size="sm" variant="ghost" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setEditing(blankWeb())}>
                Add PACS
              </Button>
            </span>
          </section>
        )}

        {node && !editing && (
          <form
            className="grid grid-cols-6 items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <div className="col-span-2"><Field label="Patient name">{(f) => <Input {...f} value={query.patientName} placeholder="DOE^J" onChange={(e) => setQuery({ ...query, patientName: e.target.value })} />}</Field></div>
            <Field label="Patient ID">{(f) => <Input {...f} value={query.patientId} onChange={(e) => setQuery({ ...query, patientId: e.target.value })} />}</Field>
            <Field label="Accession">{(f) => <Input {...f} value={query.accessionNumber} onChange={(e) => setQuery({ ...query, accessionNumber: e.target.value })} />}</Field>
            <label className="flex flex-col gap-1 text-xs font-medium text-secondary">
              Date
              <select value={query.date} onChange={(e) => setQuery({ ...query, date: e.target.value })} className={SELECT}>
                <option value="any">Any</option>
                <option value="today">Today</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="365">Last year</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-secondary">
              Modality
              <select value={query.modality} onChange={(e) => setQuery({ ...query, modality: e.target.value })} className={SELECT}>
                <option value="">Any</option>
                {["CT", "MR", "PT", "NM", "US", "CR", "DX", "MG", "XA", "RF"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <div className="col-span-6 flex justify-end">
              <Button type="submit" size="sm" loading={searching} leadingIcon={<Search className="h-4 w-4" />}>
                Search
              </Button>
            </div>
          </form>
        )}

        {rows && (
          rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-subtle p-6 text-center text-secondary">No studies match. Widen the date range or use a shorter name.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-subtle">
              <table className="w-full text-left text-xs">
                <thead className="bg-surface text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Patient</th>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Study</th>
                    <th className="px-3 py-2 font-medium">Mod.</th>
                    <th className="px-3 py-2 text-right font-medium">Images</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-subtle">
                  {rows.map((r) => {
                    const busy = retrieving?.uid === r.studyInstanceUID;
                    return (
                      <tr key={r.studyInstanceUID} className="hover:bg-elevated" onDoubleClick={() => retrieve(r)}>
                        <td className="px-3 py-2">
                          <div className="font-medium text-primary">{formatPersonName(r.patientName) || "—"}</div>
                          <div className="whitespace-nowrap text-muted tabular-nums">{[r.patientId, formatDicomDate(r.patientBirthDate)].filter(Boolean).join(" · ")}</div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-secondary">{formatDicomDate(r.studyDate)}</td>
                        <td className="max-w-[220px] truncate px-3 py-2 text-secondary" title={r.studyDescription}>{r.studyDescription || "—"}</td>
                        <td className="px-3 py-2 text-secondary">{r.modalities.join("/")}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-secondary">{r.instanceCount ?? "—"}</td>
                        <td className="px-3 py-2 text-right">
                          {busy ? (
                            <span className="flex items-center justify-end gap-2 tabular-nums text-secondary">
                              <Spinner size="sm" label="Retrieving" />
                              {retrieving.received}
                              {retrieving.total ? ` / ${retrieving.total}` : ""}
                            </span>
                          ) : (
                            <Button size="sm" variant="secondary" disabled={!!retrieving} onClick={() => retrieve(r)}>
                              Open
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </Modal>
  );
}
