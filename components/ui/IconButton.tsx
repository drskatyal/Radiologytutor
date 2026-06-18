import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";
import { Spinner } from "./Spinner";

const iconButtonVariants = cva(
  "inline-flex items-center justify-center rounded-lg transition-[transform,background-color,box-shadow,border-color,color] duration-150 ease-out " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas " +
    "active:scale-90 disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100",
  {
    variants: {
      variant: {
        ghost:
          "text-secondary hover:bg-overlay hover:text-primary active:bg-overlay/70",
        secondary:
          "border border-strong bg-elevated text-primary hover:border-accent/40 hover:bg-overlay",
        danger: "text-secondary hover:bg-danger/15 hover:text-danger",
      },
      size: {
        sm: "h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5",
        md: "h-9 w-9 [&_svg]:h-4 [&_svg]:w-4",
        lg: "h-10 w-10 [&_svg]:h-5 [&_svg]:w-5",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  }
);

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label">,
    VariantProps<typeof iconButtonVariants> {
  /** Required for accessibility — icon-only buttons have no visible text. */
  "aria-label": string;
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
        className={cn(iconButtonVariants({ variant, size }), className)}
        {...props}
      >
        {loading ? <Spinner size="sm" label="Loading" /> : children}
      </button>
    );
  }
);
IconButton.displayName = "IconButton";
