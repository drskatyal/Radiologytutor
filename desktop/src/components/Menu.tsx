// Dropdown menu for the viewer toolbar (Radix: keyboard + focus handled).
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export const MenuRoot = Dropdown.Root;
export const MenuTrigger = Dropdown.Trigger;

export function MenuContent({ children, align = "start" }: { children: ReactNode; align?: "start" | "end" | "center" }) {
  return (
    <Dropdown.Portal>
      <Dropdown.Content
        align={align}
        sideOffset={6}
        className="z-50 min-w-[220px] rounded-lg border border-strong bg-elevated p-1 text-sm text-primary shadow-lg animate-overlay-in"
      >
        {children}
      </Dropdown.Content>
    </Dropdown.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  shortcut,
  icon,
  disabled,
  checked,
}: {
  children: ReactNode;
  onSelect: () => void;
  shortcut?: string;
  icon?: ReactNode;
  disabled?: boolean;
  checked?: boolean;
}) {
  return (
    <Dropdown.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none",
        "data-[highlighted]:bg-overlay data-[disabled]:opacity-40"
      )}
    >
      <span className="flex h-4 w-4 items-center justify-center text-secondary [&_svg]:h-4 [&_svg]:w-4">
        {checked ? <Check aria-hidden /> : icon}
      </span>
      <span className="flex-1">{children}</span>
      {shortcut && <span className="text-xs text-muted tabular-nums">{shortcut}</span>}
    </Dropdown.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <Dropdown.Label className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</Dropdown.Label>;
}

export function MenuSeparator() {
  return <Dropdown.Separator className="my-1 h-px bg-subtle" />;
}
