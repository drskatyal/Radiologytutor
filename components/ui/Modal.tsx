"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
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

/**
 * Accessible modal dialog built on Radix Dialog (focus trap, scroll lock,
 * Escape + backdrop close, ARIA wiring) with framer-motion spring transitions.
 * Same `ModalProps` API as before: drive it with `open` / `onClose`.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  size = "md",
  children,
}: ModalProps) {
  const reduce = useReducedMotion();

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
              />
            </Dialog.Overlay>

            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <Dialog.Content
                asChild
                forceMount
                onOpenAutoFocus={(e) => {
                  // Avoid grabbing focus onto the first field abruptly; the panel
                  // itself is focusable, matching prior behaviour.
                  e.preventDefault();
                }}
                aria-describedby={description ? undefined : undefined}
              >
                <motion.div
                  className={cn(
                    "relative w-full overflow-hidden rounded-2xl border border-subtle bg-elevated shadow-lg surface-hairline focus:outline-none",
                    SIZES[size]
                  )}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
                  transition={
                    reduce
                      ? { duration: 0.12 }
                      : { type: "spring", duration: 0.32, bounce: 0.18 }
                  }
                  tabIndex={-1}
                >
                  {/* Accent hairline along the top edge for a premium seam. */}
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 top-0 h-px bg-subtle"
                  />
                  <div className="flex items-start justify-between gap-4 border-b border-subtle px-5 py-4">
                    <div className="min-w-0">
                      {title && (
                        <Dialog.Title className="font-display text-base font-semibold tracking-tight text-primary">
                          {title}
                        </Dialog.Title>
                      )}
                      {description && (
                        <Dialog.Description className="mt-0.5 text-sm text-muted">
                          {description}
                        </Dialog.Description>
                      )}
                    </div>
                    <Dialog.Close asChild>
                      <IconButton aria-label="Close dialog" size="sm">
                        <X />
                      </IconButton>
                    </Dialog.Close>
                  </div>

                  {children && (
                    <div className="px-5 py-4 text-sm text-secondary">{children}</div>
                  )}
                  {footer && (
                    <div className="flex items-center justify-end gap-2 border-t border-subtle bg-surface/40 px-5 py-4">
                      {footer}
                    </div>
                  )}
                </motion.div>
              </Dialog.Content>
            </div>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
