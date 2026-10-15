import type { LucideIcon } from "lucide-react";
import { iconRegistry, registeredIconNames } from "./registry.generated.ts";
import type { RegisteredIconName } from "./registry.generated.ts";

/**
 * Name-based icon lookup over the closed registry (RRR-70). A bare `import * as lucide` keeps all
 * 2,100 lucide-react icons in every bundle, because a namespace read by a runtime key cannot be
 * tree-shaken. The registry imports each icon by name instead, so a bundle carries only the icons
 * listed in registry/<owner>.txt and src/map.json.
 *
 * To draw a new icon by name, add it to your module's registry/<owner>.txt and run
 * `pnpm --filter @xos/icons generate:registry`.
 */

export { iconRegistry, registeredIconNames };
export type { RegisteredIconName };
export type IconComponent = LucideIcon;

/** Short aliases the reference Icon keeps (packages/ui Icon README). */
export const iconAliases: Readonly<Record<string, RegisteredIconName>> = {
  more: "Ellipsis",
  alert: "TriangleAlert",
  "check-circle": "CircleCheck",
  pin: "MapPin",
  home: "House",
  undo: "Undo2",
};

function pascal(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** The lucide-react component name for an icon name in PascalCase, kebab-case or a short alias. */
export function lucideName(name: string): string {
  const aliased = Object.hasOwn(iconAliases, name) ? (iconAliases[name] ?? name) : name;
  return /^[A-Z]/.test(aliased) ? aliased : pascal(aliased);
}

/** True when the name (in any accepted form) resolves to a registered icon. */
export function isRegisteredIcon(name: string): boolean {
  return Object.hasOwn(iconRegistry, lucideName(name));
}

/** The registered lucide-react component for a name, or null when it is not in the registry. */
export function resolveIcon(name: string): IconComponent | null {
  const key = lucideName(name);
  return Object.hasOwn(iconRegistry, key) ? iconRegistry[key as RegisteredIconName] : null;
}
