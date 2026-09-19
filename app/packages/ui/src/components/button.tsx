import type { ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

type Variant = "primary" | "secondary" | "ghost";

export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={cn(
        "inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        variant === "primary" && "bg-[var(--color-accent)] text-white hover:opacity-90",
        variant === "secondary" && "border border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-bg-subtle)]",
        variant === "ghost" && "hover:bg-[var(--color-bg-subtle)]",
        className,
      )}
      {...props}
    />
  );
}
