import { cx } from "../lib/cx.ts";
import { popoverPanelClass } from "../Overlays/Overlays.tsx";

export const menuClass = cx(popoverPanelClass, "min-w-(--ui-menu-min) p-4 z-dropdown");
