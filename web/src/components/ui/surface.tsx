import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// The design's repeated container treatment: faint cream-tinted bg + 1px
// inset ring. Used for app cards, install pill, stat tiles, info-sheet
// rows. The hook is a class-string so it composes onto `<button>` /
// `<a>` / etc., not only `<div>`.
export function surfaceClass({
  interactive = false,
  tone = "default",
}: {
  interactive?: boolean;
  tone?: "default" | "brand";
} = {}) {
  return cn(
    "rounded-lg ring-1 ring-inset",
    tone === "default" && "bg-foreground/[0.04] ring-foreground/[0.05]",
    tone === "brand" && "bg-brand/10 ring-brand/15",
    interactive &&
      "transition-[background-color,transform] duration-200 ease-ios hover:bg-foreground/[0.07] active:scale-[0.98]",
  );
}

export function Surface({
  className,
  interactive,
  tone,
  ...props
}: ComponentProps<"div"> & {
  interactive?: boolean;
  tone?: "default" | "brand";
}) {
  return (
    <div
      data-slot="surface"
      className={cn(surfaceClass({ interactive, tone }), className)}
      {...props}
    />
  );
}
