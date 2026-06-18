import { forwardRef } from "react";
import { cn } from "./cn";
import { Spinner } from "./Spinner";

type Variant = "ghost" | "secondary" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  ghost: "text-secondary hover:bg-elevated hover:text-primary active:bg-elevated/70",
  secondary:
    "bg-elevated text-primary border border-strong hover:bg-elevated/70",
  danger: "text-secondary hover:bg-danger/15 hover:text-danger",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5",
  md: "h-9 w-9 [&_svg]:h-4 [&_svg]:w-4",
  lg: "h-10 w-10 [&_svg]:h-5 [&_svg]:w-5",
};

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Required for accessibility — icon-only buttons have no visible text. */
  "aria-label": string;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

/** Square icon-only button. `aria-label` is mandatory by type. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      variant = "ghost",
      size = "md",
      loading = false,
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
        className={cn(
          "inline-flex items-center justify-center rounded-lg transition-colors duration-150 " +
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas " +
            "disabled:pointer-events-none disabled:opacity-50",
          VARIANTS[variant],
          SIZES[size],
          className
        )}
        {...props}
      >
        {loading ? <Spinner size="sm" label="Loading" /> : children}
      </button>
    );
  }
);
IconButton.displayName = "IconButton";
