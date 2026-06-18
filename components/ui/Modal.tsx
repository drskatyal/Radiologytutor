"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";
import { IconButton } from "./IconButton";

const SIZES = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
} as const;

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Footer actions, right-aligned. */
  footer?: React.ReactNode;
  size?: keyof typeof SIZES;
  children?: React.ReactNode;
}

/** Accessible modal dialog. Closes on Escape, backdrop click, and ✕. */
export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  size = "md",
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus the panel for keyboard users.
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 animate-overlay-in bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          "relative z-10 w-full animate-modal-in rounded-2xl border border-subtle bg-elevated shadow-lg focus:outline-none",
          SIZES[size]
        )}
      >
        {(title || true) && (
          <div className="flex items-start justify-between gap-4 border-b border-subtle px-5 py-4">
            <div className="min-w-0">
              {title && (
                <h2 className="text-base font-semibold text-primary">{title}</h2>
              )}
              {description && (
                <p className="mt-0.5 text-sm text-muted">{description}</p>
              )}
            </div>
            <IconButton aria-label="Close dialog" size="sm" onClick={onClose}>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
              </svg>
            </IconButton>
          </div>
        )}
        {children && <div className="px-5 py-4 text-sm text-secondary">{children}</div>}
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-subtle px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
