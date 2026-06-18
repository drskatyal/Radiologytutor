import { forwardRef } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./cn";

const CONTROL_BASE =
  "w-full rounded-lg border border-strong bg-canvas/80 px-3 text-sm text-primary shadow-sm " +
  "placeholder:text-muted transition-[border-color,box-shadow,background-color] duration-150 " +
  "hover:border-strong/80 focus:border-accent focus:bg-canvas focus:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-accent/35 focus-visible:ring-offset-0 " +
  "disabled:cursor-not-allowed disabled:opacity-50 " +
  "aria-[invalid=true]:border-danger aria-[invalid=true]:focus:border-danger " +
  "aria-[invalid=true]:focus-visible:ring-danger/40";

export const Input = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type = "text", ...props }, ref) => {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(CONTROL_BASE, "h-10", className)}
      {...props}
    />
  );
});
Input.displayName = "Input";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, rows = 4, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(CONTROL_BASE, "resize-y py-2 leading-relaxed", className)}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(
            CONTROL_BASE,
            "h-10 appearance-none pr-9 [&>option]:bg-elevated [&>option]:text-primary",
            className
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
        />
      </div>
    );
  }
);
Select.displayName = "Select";
