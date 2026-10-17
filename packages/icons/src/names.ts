import { registeredIconNames, type RegisteredIconName } from "./names.generated.ts";

/**
 * Icon names without icon components: what a web bundle needs to draw from the sprite
 * (`@xos/icons/sprite.svg`, ADR 0027). Every name here is a symbol id in the sprite.
 */

export { registeredIconNames };
export type { RegisteredIconName };

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

let known: ReadonlySet<string> | null = null;

/** True when the name (in any accepted form) resolves to a registered icon. */
export function isRegisteredIcon(name: string): boolean {
  known ??= new Set<string>(registeredIconNames);
  return known.has(lucideName(name));
}
