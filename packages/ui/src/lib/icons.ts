import * as lucide from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** Short aliases the reference Icon keeps (Icon README). */
const ALIASES: Record<string, string> = {
  more: "Ellipsis",
  alert: "TriangleAlert",
  "check-circle": "CircleCheck",
  pin: "MapPin",
  home: "House",
  undo: "Undo2",
};

/** Icons that point along the reading direction and mirror in right-to-left locales. */
const MIRRORED = new Set([
  "ChevronRight",
  "ChevronLeft",
  "ArrowUpRight",
  "ArrowRight",
  "ArrowLeft",
  "Undo2",
  "Send",
  "ExternalLink",
]);

function pascal(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** The Lucide component name for an icon name in PascalCase, kebab-case or a short alias. */
export function lucideName(name: string): string {
  const aliased = ALIASES[name] ?? name;
  return /^[A-Z]/.test(aliased) ? aliased : pascal(aliased);
}

const registry = lucide as unknown as Record<string, unknown>;

/** Resolves a Lucide icon component, or null when the name does not exist in the pinned release. */
export function resolveIcon(name: string): LucideIcon | null {
  const key = lucideName(name);
  if (key === "icons" || key === "createLucideIcon" || key === "useLucideContext") return null;
  const candidate = registry[key];
  return typeof candidate === "object" || typeof candidate === "function"
    ? (candidate as LucideIcon)
    : null;
}

export function isMirrored(name: string): boolean {
  return MIRRORED.has(lucideName(name));
}
