import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// Mono caps caption — the design uses this for section labels
// ("YOUR APPS"), meta lines ("v12 · 2h ago"), and chrome tags
// ($ BASH, FROM TEMPLATE, etc). Geist Mono, uppercase, wide tracking,
// muted by default. Pass `as="span"` for inline use.
export function Caption({
  className,
  variant = "section",
  ...props
}: ComponentProps<"span"> & {
  variant?: "section" | "meta" | "chip";
}) {
  return (
    <span
      data-slot="caption"
      className={cn(
        "font-mono",
        variant === "section" && "text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70",
        variant === "meta" && "text-[10.5px] tracking-[0.02em] text-muted-foreground/70",
        variant === "chip" && "text-[10px] uppercase tracking-[0.06em] text-muted-foreground/80",
        className,
      )}
      {...props}
    />
  );
}
