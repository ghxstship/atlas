import type { LucideIcon } from "lucide-react";
import { lucideName } from "./names.ts";
import { iconRegistry } from "./registry.generated.ts";
import type { RegisteredIconName } from "./registry.generated.ts";

/**
 * Name-based icon components over the closed registry (RRR-70). A bare `import * as lucide` keeps
 * all 2,100 lucide-react icons in every bundle, because a namespace read by a runtime key cannot be
 * tree-shaken. The registry imports each icon by name instead, so a bundle carries only the icons
 * listed in registry/<owner>.txt and src/map.json. Web pages draw the same icons from the sprite
 * instead (`@xos/ui` Icon, ADR 0027) and never load these components.
 *
 * To draw a new icon by name, add it to your module's registry/<owner>.txt and run
 * `pnpm --filter @xos/icons generate:registry`.
 */

export { iconRegistry };
export type IconComponent = LucideIcon;

/** The registered lucide-react component for a name, or null when it is not in the registry. */
export function resolveIcon(name: string): IconComponent | null {
  const key = lucideName(name);
  return Object.hasOwn(iconRegistry, key) ? iconRegistry[key as RegisteredIconName] : null;
}
