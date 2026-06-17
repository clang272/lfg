import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// 48x48 icon slot used by the project bottom bar: muted text by default,
// foreground + soft secondary fill on hover, scales on press. Lives next to
// `<Button>` because its sizing/rounding are bar-specific (rounded-lg, no
// border/ring) and the bar packs three of them next to a wider compose
// trigger. The version chip uses the same shell but overrides the inner
// content to mono digits, so `className` is passed through.
export const BarButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(function BarButton({ className, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[transform,background-color,color] duration-150 ease-ios hover:bg-secondary hover:text-foreground active:scale-[0.95] disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
