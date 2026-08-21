import { cn } from "./cn";

export function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "rounded border border-strong bg-elevated px-1.5 py-0.5 font-sans text-[10px] font-medium text-secondary",
        className
      )}
    >
      {children}
    </kbd>
  );
}
