"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useDragControls, useReducedMotion, type DragControls, type PanInfo } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "./cn";
import { IconButton } from "./IconButton";
import { shouldDismissSheet } from "@/lib/sheetGesture";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Dark chrome for sheets that sit over the imaging stage. */
  tone?: "default" | "imaging";
  children?: React.ReactNode;
}

/**
 * Bottom sheet for phones: slides up from the bottom edge, drag the handle (or
 * anywhere on the header) down to dismiss, Escape and the backdrop close it.
 * Radix Dialog supplies the focus trap, scroll lock and ARIA wiring, like Modal.
 */
export function Sheet({ open, onClose, title, description, tone = "default", children }: SheetProps) {
  const reduce = useReducedMotion();
  const controls = useDragControls();
  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (shouldDismissSheet(info.offset.y, info.velocity.y)) onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/60"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
              />
            </Dialog.Overlay>
            <Dialog.Content
              asChild
              forceMount
              onOpenAutoFocus={(e) => e.preventDefault()}
              aria-describedby={undefined}
            >
              <motion.div
                className={cn(
                  "fixed inset-x-0 bottom-0 z-50 flex max-h-[80dvh] flex-col rounded-t-2xl border-t shadow-lg focus:outline-none",
                  "pb-[env(safe-area-inset-bottom)]",
                  tone === "imaging" ? "border-white/10 bg-neutral-950 text-white" : "border-subtle bg-elevated text-primary"
                )}
                initial={reduce ? { opacity: 0 } : { y: "100%" }}
                animate={reduce ? { opacity: 1 } : { y: 0 }}
                exit={reduce ? { opacity: 0 } : { y: "100%" }}
                transition={reduce ? { duration: 0.12 } : { type: "spring", duration: 0.34, bounce: 0.12 }}
                drag={reduce ? false : "y"}
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0, bottom: 0.6 }}
                dragListener={false}
                dragControls={controls}
                onDragEnd={onDragEnd}
                tabIndex={-1}
              >
                <SheetHeader title={title} description={description} tone={tone} controls={reduce ? null : controls} />
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">{children}</div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

/** The grab area: dragging it moves the whole sheet; the list below still scrolls. */
function SheetHeader({
  title,
  description,
  tone,
  controls,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  tone: "default" | "imaging";
  controls: DragControls | null;
}) {
  return (
    <div className="flex touch-none flex-col gap-2 px-4 pb-3 pt-2" onPointerDown={(e) => controls?.start(e)}>
      <span aria-hidden className={cn("mx-auto h-1 w-10 rounded-full", tone === "imaging" ? "bg-white/30" : "bg-strong")} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
          {description && (
            <Dialog.Description className={cn("mt-0.5 text-xs", tone === "imaging" ? "text-white/60" : "text-muted")}>
              {description}
            </Dialog.Description>
          )}
        </div>
        <Dialog.Close asChild>
          <IconButton aria-label="Close" size="sm" className={tone === "imaging" ? "text-white hover:bg-white/10" : undefined}>
            <X />
          </IconButton>
        </Dialog.Close>
      </div>
    </div>
  );
}
