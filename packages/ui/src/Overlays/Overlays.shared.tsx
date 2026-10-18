import { cx } from "../lib/cx.ts";
import { useControllable } from "../lib/hooks.ts";
import { type OverlayControl } from "./Overlays.types.ts";

export const scrimClass = cx(
  "xos-anim-fade fixed inset-0 z-dialog bg-scrim opacity-scrim-dark",
  "in-data-[theme=light]:opacity-scrim-light in-data-[theme=sunlight]:opacity-scrim-light",
);

export function useOverlayOpen({ open, defaultOpen, onOpenChange, trigger }: OverlayControl) {
  return useControllable(open, defaultOpen ?? trigger === undefined, onOpenChange);
}
