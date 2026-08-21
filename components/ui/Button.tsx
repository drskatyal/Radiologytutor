import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";
import { Spinner } from "./Spinner";

/**
 * The single source of truth for buttons. Never hand-roll one.
 *
 * Styled with class-variance-authority for typed, composable variants. The
 * exported variant/size names and `ButtonProps` shape are unchanged, so every
 * existing call site keeps working.
 */
const buttonVariants = cva(
  "group/btn relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium " +
    "transition-[transform,background-color,box-shadow,border-color,color] duration-150 ease-out select-none " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas " +
    "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-foreground shadow-sm hover:brightness-[1.05] active:brightness-100",
        secondary:
          "border border-strong bg-elevated text-primary shadow-sm hover:border-accent/40 hover:bg-overlay active:bg-elevated",
        ghost:
          "text-secondary hover:bg-overlay hover:text-primary active:bg-overlay/70",
        danger:
          "bg-danger text-white shadow-sm hover:brightness-[1.07] active:brightness-100",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-10 px-4 text-sm",
        lg: "h-11 px-5 text-sm",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  /** Icon rendered before the label. */
  leadingIcon?: React.ReactNode;
  /** Icon rendered after the label. */
  trailingIcon?: React.ReactNode;
}

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
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      >
        {loading ? (
          <Spinner size="sm" label="Loading" />
        ) : (
          leadingIcon && (
            <span className="shrink-0 [&_svg]:h-4 [&_svg]:w-4">{leadingIcon}</span>
          )
        )}
        {children && <span className="truncate">{children}</span>}
        {!loading && trailingIcon && (
          <span className="shrink-0 transition-transform duration-150 group-hover/btn:translate-x-0.5 [&_svg]:h-4 [&_svg]:w-4">
            {trailingIcon}
          </span>
        )}
      </button>
    );
  }
);
Button.displayName = "Button";

export { buttonVariants };
