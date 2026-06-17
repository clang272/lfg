import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

// Per-initial warm color so an avatar grid doesn't read as one long coral
// stripe. Sourced from the --avatar-tint-* token ramp in index.css; unseen
// initials fall back to the brand token — the design only specifies six.
const TINTS: Record<string, string> = {
  M: "var(--avatar-tint-m)",
  S: "var(--avatar-tint-s)",
  J: "var(--avatar-tint-j)",
  R: "var(--avatar-tint-r)",
  A: "var(--avatar-tint-a)",
  Y: "var(--avatar-tint-y)",
};

const FALLBACK_TINT = "var(--brand)";

// Shared initials-in-a-circle avatar. The single recipe both the inspect
// people/data grids and the home/account chrome reach for.
//
//   - tone="tint" (default) paints the per-initial --avatar-tint-* gradient
//     with a white initial — the look the inspect people grid wants.
//   - tone="neutral" keeps the un-tinted secondary surface the home/account
//     avatar uses, so it reads as chrome rather than a person.
export function Avatar({
  initial,
  size = 38,
  online,
  tone = "tint",
  className,
}: {
  initial: string;
  size?: number;
  online?: boolean;
  tone?: "tint" | "neutral";
  className?: string;
}) {
  const init = (initial || "?").slice(0, 1).toUpperCase();
  const tinted = tone === "tint";
  const tint = TINTS[init] ?? FALLBACK_TINT;
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: size / 2,
    fontSize: size * 0.42,
    letterSpacing: "-0.02em",
  };
  if (tinted) {
    style.backgroundImage = `linear-gradient(155deg, ${tint}, color-mix(in srgb, ${tint} 80%, transparent))`;
    // Inset top highlight gloss — purely optical, no theme token applies.
    style.boxShadow = "inset 0 1px 0 rgba(255,255,255,0.25)";
  }
  return (
    <div
      className={cn(
        "relative flex shrink-0 select-none items-center justify-center font-display",
        tinted
          ? "font-bold text-white"
          : "bg-secondary/70 font-semibold text-foreground/80 ring-1 ring-inset ring-foreground/5",
        className,
      )}
      style={style}
      aria-hidden
    >
      <span>{init}</span>
      {online && (
        <span
          className="absolute -bottom-px -right-px rounded-full bg-success ring-2 ring-background"
          style={{ width: size * 0.3, height: size * 0.3 }}
        />
      )}
    </div>
  );
}
