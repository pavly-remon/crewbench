import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4 shadow-sm", className)}
      {...props}
    />
  );
}
