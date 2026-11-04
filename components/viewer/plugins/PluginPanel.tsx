"use client";

// Right-side plugin panel with an icon tab rail. Rendered only when plugins
// are configured (off by default). Each tab mounts the plugin's own panel
// element (created by the host); the rail stays visible when the panel is
// collapsed so the reading area is never covered.

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Mic, PanelRightClose, Puzzle } from "lucide-react";
import { IconButton, Spinner, cn } from "@/components/ui";
import type { PluginEntry } from "@flowrad/viewer-core";

function TabIcon({ entry }: { entry: PluginEntry }) {
  if (entry.icon && /^(https:|data:image\/)/.test(entry.icon)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={entry.icon} alt="" className="h-5 w-5 rounded" />;
  }
  if (entry.icon) return <span className="text-sm font-semibold">{entry.icon}</span>;
  return <Puzzle className="h-4 w-4" aria-hidden />;
}

function MountPanel({ element }: { element: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.appendChild(element);
    return () => {
      if (element.parentElement === host) host.removeChild(element);
    };
  }, [element]);
  return <div ref={ref} className="min-h-0 flex-1 overflow-y-auto p-3 text-sm text-white/85" />;
}

function MicActionButton({ action }: { action: PluginEntry["micActions"][number] }) {
  const [on, setOn] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => {
        if (on) action.onStop();
        else action.onStart();
        setOn(!on);
      }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
        on ? "border-accent bg-accent text-white" : "border-white/15 text-white/80 hover:bg-white/10"
      )}
    >
      <Mic className="h-3.5 w-3.5" aria-hidden />
      {action.label}
      {action.hotkey && <span className="text-white/50">{action.hotkey}</span>}
    </button>
  );
}

export function PluginPanel({ entries, loading }: { entries: PluginEntry[]; loading: boolean }) {
  const [active, setActive] = useState<string | null>(null);
  const current = entries.find((e) => e.id === active) ?? null;

  return (
    <div className="hidden min-h-0 shrink-0 border-l border-white/10 bg-imaging text-white lg:flex" data-testid="plugin-panel">
      {current && (
        <section aria-label={`${current.name} plugin`} className="flex w-80 min-w-0 flex-col border-r border-white/10">
          <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{current.name}</h2>
            <IconButton aria-label="Close plugin panel" title="Close" size="sm" variant="ghost" className="text-white/70 hover:bg-white/10 hover:text-white" onClick={() => setActive(null)}>
              <PanelRightClose />
            </IconButton>
          </header>
          {current.micActions.length > 0 && (
            <div className="flex flex-wrap gap-2 border-b border-white/10 px-3 py-2">
              {current.micActions.map((a) => (
                <MicActionButton key={a.label} action={a} />
              ))}
            </div>
          )}
          {current.status === "error" ? (
            <p role="alert" className="m-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-white/85">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
              {current.error ?? "This plugin could not start."}
            </p>
          ) : (
            <MountPanel element={current.panel} />
          )}
        </section>
      )}
      <nav aria-label="Plugins" className="flex w-11 flex-col items-center gap-1 py-2">
        {loading && entries.length === 0 && <Spinner size="sm" label="Loading plugins" />}
        {entries.map((e) => (
          <button
            key={e.id}
            type="button"
            title={e.status === "error" ? `${e.name}: failed to load` : e.name}
            aria-label={e.name}
            aria-pressed={active === e.id}
            onClick={() => setActive(active === e.id ? null : e.id)}
            className={cn(
              "relative flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
              active === e.id ? "bg-white/15 text-white" : "hover:bg-white/10"
            )}
          >
            <TabIcon entry={e} />
            {e.status === "error" && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-warning" aria-hidden />}
          </button>
        ))}
      </nav>
    </div>
  );
}
