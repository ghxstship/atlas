import { cx } from "../lib/cx.ts";

/**
 * The avatar's initials and classes without the component: no hooks and no context, so a server
 * component can draw the same circle (ADR 0027).
 */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

export const avatarClass = cx(
  "inline-grid place-items-center flex-none rounded-full bg-bg-hover text-text-primary font-semibold",
  "ring-(length:--stroke-width-focus) ring-bg-canvas",
);
