import { forwardRef } from "react";
import { cn } from "./cn";
import { Spinner } from "./Spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium " +
  "transition-colors duration-150 select-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas " +
  "disabled:pointer-events-none disabled:opacity-50";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-foreground hover:bg-accent/90 active:bg-accent/80 shadow-sm",
  secondary:
    "bg-elevated text-primary border border-strong hover:bg-elevated/70 hover:border-strong active:bg-elevated",
  ghost: "text-secondary hover:bg-elevated hover:text-primary active:bg-elevated/70",
  danger:
    "bg-danger text-white hover:bg-danger/90 active:bg-danger/80 shadow-sm",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  /** Icon rendered before the label. */
  leadingIcon?: React.ReactNode;
  /** Icon rendered after the label. */
  trailingIcon?: React.ReactNode;
}

/** The single source of truth for buttons. Never hand-roll one. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading = false,
      leadingIcon,
      trailingIcon,
      disabled,
      className,
      children,
      type = "button",
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
        {...props}
      >
        {loading ? (
          <Spinner size="sm" label="Loading" />
        ) : (
          leadingIcon && <span className="shrink-0">{leadingIcon}</span>
        )}
        {children && <span className="truncate">{children}</span>}
        {!loading && trailingIcon && (
          <span className="shrink-0">{trailingIcon}</span>
        )}
      </button>
    );
  }
);
Button.displayName = "Button";
