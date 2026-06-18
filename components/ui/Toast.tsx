"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  CheckCircle2,
  Info,
  TriangleAlert,
  X,
  XCircle,
} from "lucide-react";
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
  success: <CheckCircle2 className="h-4 w-4 text-success" />,
  warning: <TriangleAlert className="h-4 w-4 text-warning" />,
  danger: <XCircle className="h-4 w-4 text-danger" />,
  info: <Info className="h-4 w-4 text-info" />,
};

/**
 * Wrap the app once (in the shell). Provides `useToast()`.
 *
 * Built on Radix Toast for accessibility (swipe-to-dismiss, hotkey, live
 * region) with framer-motion entrance/exit. The imperative API — `toast(opts)`
 * returning a numeric id and `dismiss(id)` — is unchanged.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const reduce = useReducedMotion();

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((opts: ToastOptions) => {
    const id = nextId.current++;
    const item: ToastItem = {
      id,
      title: opts.title,
      description: opts.description,
      variant: opts.variant ?? "default",
      duration: opts.duration ?? 4000,
    };
    setToasts((prev) => [...prev, item]);
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right">
        {children}

        <AnimatePresence>
          {toasts.map((t) => (
            <ToastPrimitive.Root
              key={t.id}
              asChild
              forceMount
              duration={t.duration === 0 ? Infinity : t.duration}
              onOpenChange={(open) => {
                if (!open) dismiss(t.id);
              }}
            >
              <motion.li
                layout
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.96 }}
                transition={{ type: "spring", duration: 0.36, bounce: 0.2 }}
                className={cn(
                  "pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-xl border border-subtle bg-elevated py-3 pl-4 pr-3 shadow-lg surface-hairline",
                  "before:absolute before:inset-y-0 before:left-0 before:w-1",
                  ACCENTS[t.variant]
                )}
              >
                {ICONS[t.variant] && (
                  <div className="mt-0.5 shrink-0">{ICONS[t.variant]}</div>
                )}
                <div className="min-w-0 flex-1">
                  <ToastPrimitive.Title className="text-sm font-medium text-primary">
                    {t.title}
                  </ToastPrimitive.Title>
                  {t.description && (
                    <ToastPrimitive.Description className="mt-0.5 text-sm text-muted">
                      {t.description}
                    </ToastPrimitive.Description>
                  )}
                </div>
                <ToastPrimitive.Close
                  aria-label="Dismiss notification"
                  className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-surface hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  <X className="h-3.5 w-3.5" />
                </ToastPrimitive.Close>
              </motion.li>
            </ToastPrimitive.Root>
          ))}
        </AnimatePresence>

        <ToastPrimitive.Viewport className="pointer-events-none fixed bottom-4 right-4 z-[60] m-0 flex w-full max-w-sm list-none flex-col gap-2 p-0 outline-none" />
      </ToastPrimitive.Provider>
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
