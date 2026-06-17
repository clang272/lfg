import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared empty-state for the inspect tabs (and anywhere else): a centered
// icon-circle, title, optional description, and an optional action node.
//
// Standardizes what used to drift per tab — the icon-circle radius
// (rounded-[14px] vs rounded-full) and bg tint (/[0.05] vs /[0.06]) — onto a
// single recipe: rounded-full bg-foreground/[0.06]. The icon inherits
// text-muted-foreground from the circle, so pass a bare lucide icon.
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center",
        className,
      )}
    >
      {icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground">
          {icon}
        </div>
      )}
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-sm font-semibold tracking-[-0.02em]">{title}</span>
        {description && (
          <p className="max-w-[320px] text-xs leading-[1.45] tracking-[-0.01em] text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
