// Optional RadLearn account: sign in, and send a study to your RadLearn
// studio. Anonymised on this machine (desktop/src-tauri/src/anonymize.rs)
// before a byte leaves it; the server de-identifies again on arrival.

import { useEffect, useState } from "react";
import { CloudUpload, ShieldCheck } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Field } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { invoke, isTauri, listen } from "../platform";
import type { ViewerSeries, ViewerStudy } from "../types";

export interface SyncStatus {
  signedIn: boolean;
  server?: string;
  email?: string;
  name?: string | null;
}

export function useSyncStatus() {
  const [status, setStatus] = useState<SyncStatus>({ signedIn: false });
  const refresh = () => {
    if (isTauri) invoke<SyncStatus>("sync_status").then(setStatus, () => undefined);
  };
  useEffect(refresh, []);
  return { status, setStatus, refresh };
}

export function AccountSection({ status, onChange }: { status: SyncStatus; onChange: (s: SyncStatus) => void }) {
  const { toast } = useToast();
  const [server, setServer] = useState(status.server ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setServer((s) => s || status.server || ""), [status.server]);

  if (!isTauri) return null;
  return (
    <section className="py-3">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">RadLearn account (optional)</h3>
      {status.signedIn ? (
        <div className="flex items-center justify-between gap-4 py-2">
          <span>
            <span className="block text-sm font-medium text-primary">{status.name || status.email}</span>
            <span className="block text-xs text-muted">
              {status.email} · {status.server}
            </span>
          </span>
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await invoke("sync_sign_out");
                onChange({ signedIn: false, server: status.server });
              } finally {
                setBusy(false);
              }
            }}
          >
            Sign out
          </Button>
        </div>
      ) : (
        <form
          className="grid grid-cols-2 gap-3 py-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const next = await invoke<SyncStatus>("sync_sign_in", { server, email, password });
              setPassword("");
              onChange(next);
              toast({ title: "Signed in to RadLearn", description: next.server, variant: "success" });
            } catch (err) {
              toast({ title: "Sign-in failed", description: String(err), variant: "danger" });
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="col-span-2 text-xs text-muted">
            Only needed to send studies to your RadLearn studio. Viewing never requires an account.
          </p>
          <div className="col-span-2">
            <Field label="RadLearn address">{(f) => <Input {...f} value={server} placeholder="https://learn.yourhospital.org" onChange={(e) => setServer(e.target.value)} />}</Field>
          </div>
          <Field label="Email">{(f) => <Input {...f} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Password">{(f) => <Input {...f} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <div className="col-span-2 flex justify-end">
            <Button type="submit" size="sm" loading={busy} disabled={!email || !password}>
              Sign in
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

export function SendToRadLearnDialog({
  open,
  onClose,
  status,
  series,
  study,
}: {
  open: boolean;
  onClose: () => void;
  status: SyncStatus;
  series: ViewerSeries | null;
  study: ViewerStudy | null;
}) {
  const { toast } = useToast();
  const [scope, setScope] = useState<"series" | "study">("study");
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const headers = scope === "study" && study ? study.series.flatMap((s) => s.headers) : series?.headers ?? [];
  const ids = [...new Set(headers.map((h) => h.fileId))];

  const send = async () => {
    setProgress({ sent: 0, total: ids.length });
    const off = await listen<{ sent: number; total: number }>("upload-progress", setProgress);
    try {
      const paths = (await invoke<(string | null)[]>("paths_for_ids", { fileIds: ids })).filter((p): p is string => !!p);
      const result = await invoke<{ sent: number; failed: number; server: string }>("sync_upload_study", { paths });
      toast({
        title: result.failed ? `Sent ${result.sent - result.failed} of ${result.sent} images` : `Sent ${result.sent} images to RadLearn`,
        description: `Anonymised on this computer. Create the case in your studio at ${result.server}/studio.`,
        variant: result.failed ? "warning" : "success",
        duration: 10000,
      });
      onClose();
    } catch (err) {
      toast({ title: "Upload failed", description: String(err), variant: "danger", duration: 10000 });
    } finally {
      off();
      setProgress(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={progress ? () => undefined : onClose}
      title="Send to RadLearn"
      description={status.signedIn ? `To ${status.server} as ${status.email}` : "Sign in from Settings first."}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={!!progress}>
            Cancel
          </Button>
          <Button onClick={send} loading={!!progress} disabled={!status.signedIn || ids.length === 0} leadingIcon={<CloudUpload className="h-4 w-4" />}>
            Anonymise and send
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1 text-secondary">
          What to send
          <select value={scope} onChange={(e) => setScope(e.target.value as "series" | "study")} className="h-9 rounded-lg border border-strong bg-elevated px-2 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <option value="study">Whole study ({study?.imageCount ?? 0} images)</option>
            <option value="series">This series ({series?.imageCount ?? 0} images)</option>
          </select>
        </label>
        <p className="flex items-start gap-2 rounded-lg border border-subtle bg-surface p-3 text-xs text-secondary">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
          Every file is anonymised on this computer before upload (names, IDs, birth date, institution, private tags;
          UIDs remapped). Burned-in text in the pixels is not removed — check ultrasound and scanned images.
        </p>
        {progress && (
          <div role="status" aria-live="polite" className="flex flex-col gap-1">
            <div className="text-xs text-secondary tabular-nums">
              Sent {progress.sent} / {progress.total}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-overlay">
              <div className="h-full rounded-full bg-accent" style={{ width: `${(100 * progress.sent) / Math.max(1, progress.total)}%` }} />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
