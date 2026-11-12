// Toasts without paying for them at startup.
//
// The shared `components/ui/Toast` is Radix Toast + framer-motion: about a
// third of the start-screen bundle, for a UI the start screen never shows.
// This keeps its exact API (`useToast().toast(opts) → id`, `dismiss(id)`) and
// its look — it renders the real component — but loads it on the first toast
// (or in idle time after first paint), queueing anything raised before then.

import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ToastOptions } from "@/components/ui/Toast";

interface ToastApi {
  toast: (opts: ToastOptions) => number;
  dismiss: (id: number) => void;
}

type Pending = { kind: "toast"; id: number; opts: ToastOptions } | { kind: "dismiss"; id: number };

const ToastContext = createContext<ToastApi | null>(null);

/** Sends queued calls to the real provider once it has mounted. */
type Sink = (call: Pending) => void;

const RealToaster = lazy(async () => {
  const ui = await import("@/components/ui/Toast");
  function Bridge({ register }: { register: (sink: Sink) => void }) {
    const real = ui.useToast();
    // Our ids are stable from the first call; map them to the real ones.
    const ids = useRef(new Map<number, number>());
    useEffect(() => {
      register((call) => {
        if (call.kind === "toast") ids.current.set(call.id, real.toast(call.opts));
        else {
          const realId = ids.current.get(call.id);
          if (realId != null) real.dismiss(realId);
          ids.current.delete(call.id);
        }
      });
    }, [real, register]);
    return null;
  }
  function Toaster({ register }: { register: (sink: Sink) => void }) {
    return (
      <ui.ToastProvider>
        <Bridge register={register} />
      </ui.ToastProvider>
    );
  }
  return { default: Toaster };
});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [load, setLoad] = useState(false);
  const queue = useRef<Pending[]>([]);
  const sink = useRef<Sink | null>(null);
  const nextId = useRef(1);

  const send = useCallback((call: Pending) => {
    if (sink.current) sink.current(call);
    else {
      queue.current.push(call);
      setLoad(true);
    }
  }, []);

  const register = useCallback((s: Sink) => {
    sink.current = s;
    for (const call of queue.current.splice(0)) s(call);
  }, []);

  // Warm in idle time well after first paint, so the first real toast is instant.
  useEffect(() => {
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    const timer = window.setTimeout(() => (idle ? idle(() => setLoad(true), { timeout: 4000 }) : setLoad(true)), 3000);
    return () => window.clearTimeout(timer);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast: (opts) => {
        const id = nextId.current++;
        send({ kind: "toast", id, opts });
        return id;
      },
      dismiss: (id) => send({ kind: "dismiss", id }),
    }),
    [send]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {load && (
        <Suspense fallback={null}>
          <RealToaster register={register} />
        </Suspense>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
