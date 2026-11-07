"use client";

import { buttonVariants, type ButtonProps } from "./Button";
import { cn } from "./cn";

export interface FilePickerButtonProps {
  /** id of the (visually hidden) <input type="file"> this opens. */
  inputId: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  leadingIcon?: React.ReactNode;
  className?: string;
  /** Runs alongside opening the picker (e.g. close a drawer first). */
  onClick?: () => void;
  children: React.ReactNode;
}

/**
 * A button that opens a file picker. It is a native <label for> bound to the
 * input, so the browser opens the chooser itself: no script on the click path,
 * nothing to lose to slow hydration or an overlay-swallowed handler (the P0 on
 * /viewer/local). Looks and focuses exactly like <Button>; Enter and Space work
 * from the keyboard.
 */
export function FilePickerButton({
  inputId,
  variant = "primary",
  size = "md",
  leadingIcon,
  className,
  onClick,
  children,
}: FilePickerButtonProps) {
  return (
    <label
      htmlFor={inputId}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onClick?.();
        (document.getElementById(inputId) as HTMLInputElement | null)?.click();
      }}
      className={cn(buttonVariants({ variant, size }), "cursor-pointer", className)}
    >
      {leadingIcon && <span className="shrink-0 [&_svg]:h-4 [&_svg]:w-4">{leadingIcon}</span>}
      <span className="truncate">{children}</span>
    </label>
  );
}
