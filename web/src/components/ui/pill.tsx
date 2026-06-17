import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Small inline chip used for status tags, file attachments, the "Install"
// chip, version monograms, and anything else that wants to read as a
// system tag rather than a button. Geist Mono uppercase by default so it
// looks like a label, not body text. For interactive chips wrap in a
// `<button>` (or render alongside a `<Button size="icon-xs">` for an X).
const pillVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1 rounded-full font-mono uppercase tracking-[0.06em] whitespace-nowrap",
  {
    variants: {
      tone: {
        default: "bg-foreground/[0.06] text-foreground/70",
        brand: "bg-brand/12 text-brand",
        success: "bg-success/12 text-success",
        warning: "bg-warning/12 text-warning",
        info: "bg-info/12 text-info",
        danger: "bg-destructive/12 text-destructive",
      },
      size: {
        sm: "h-5 px-2 text-[10px]",
        md: "h-6 px-2.5 text-[11px]",
      },
    },
    defaultVariants: {
      tone: "default",
      size: "md",
    },
  },
);

export function Pill({
  className,
  tone,
  size,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof pillVariants>) {
  return (
    <span
      data-slot="pill"
      className={cn(pillVariants({ tone, size }), className)}
      {...props}
    />
  );
}

export { pillVariants };
