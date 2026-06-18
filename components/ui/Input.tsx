import { forwardRef } from "react";
import { cn } from "./cn";

const CONTROL_BASE =
  "w-full rounded-lg border border-strong bg-canvas px-3 text-sm text-primary " +
  "placeholder:text-muted transition-colors duration-150 " +
  "hover:border-strong focus:border-accent focus:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-0 " +
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
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
        >
          <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    );
  }
);
Select.displayName = "Select";
