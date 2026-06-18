"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "./cn";

type ToastVariant = "default" | "success" | "warning" | "danger" | "info";

export interface ToastOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  /** Auto-dismiss after ms. Set 0 to require manual dismiss. Default 4000. */
  duration?: number;
}

interface ToastItem extends Required<Omit<ToastOptions, "description">> {
  id: number;
  description?: React.ReactNode;
}

interface ToastContextValue {
  toast: (opts: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ACCENTS: Record<ToastVariant, string> = {
  default: "before:bg-accent",
  success: "before:bg-success",
  warning: "before:bg-warning",
  danger: "before:bg-danger",
  info: "before:bg-info",
};

const ICONS: Record<ToastVariant, React.ReactNode> = {
  default: null,
  success: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-4 w-4 text-success">
      <path d="M4 10l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-4 w-4 text-warning">
      <path d="M10 6v5M10 14h.01" strokeLinecap="round" />
    </svg>
  ),
  danger: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-4 w-4 text-danger">
      <path d="M6 6l8 8M14 6l-8 8" strokeLinecap="round" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-4 w-4 text-info">
      <path d="M10 9v5M10 6h.01" strokeLinecap="round" />
    </svg>
  ),
};

/** Wrap the app once (in the shell). Provides `useToast()`. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (opts: ToastOptions) => {
      const id = nextId.current++;
      const item: ToastItem = {
        id,
        title: opts.title,
        description: opts.description,
        variant: opts.variant ?? "default",
        duration: opts.duration ?? 4000,
      };
      setToasts((prev) => [...prev, item]);
      if (item.duration > 0) {
        setTimeout(() => dismiss(id), item.duration);
      }
      return id;
    },
    [dismiss]
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              "pointer-events-auto relative flex animate-fade-up items-start gap-3 overflow-hidden rounded-xl border border-subtle bg-elevated py-3 pl-4 pr-3 shadow-lg",
              "before:absolute before:inset-y-0 before:left-0 before:w-1",
              ACCENTS[t.variant]
            )}
          >
            {ICONS[t.variant] && <div className="mt-0.5 shrink-0">{ICONS[t.variant]}</div>}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-primary">{t.title}</p>
              {t.description && (
                <p className="mt-0.5 text-sm text-muted">{t.description}</p>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-surface hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-3.5 w-3.5">
                <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Access the toast API. Must be used within a ToastProvider. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return ctx;
}
