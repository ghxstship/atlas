import { isRegisteredIcon, lucideName } from "@xos/icons/names";
import sprite from "@xos/icons/sprite.svg";

export { lucideName };

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

/**
 * URL of the icon sprite (ADR 0027): one SVG file of every registered icon, emitted by the bundler
 * with a content hash so browsers cache it as a static asset. Next.js imports a static file as
 * `{ src }`, Vite as a string.
 */
export const iconSpriteUrl: string = typeof sprite === "string" ? sprite : sprite.src;

const warned = new Set<string>();

/**
 * The sprite symbol id for an icon name. In development a name outside the @xos/icons registry
 * warns once, so it is added to the owner's registry list rather than shipping an empty square;
 * production skips the check, so no name list reaches the page.
 */
export function iconSymbol(name: string): string {
  const id = lucideName(name);
  if (process.env["NODE_ENV"] !== "production" && !warned.has(name) && !isRegisteredIcon(name)) {
    warned.add(name);
    console.warn(
      `@xos/ui Icon: "${name}" is not in the @xos/icons registry. Add ${id} to packages/icons/registry/<owner>.txt and run pnpm --filter @xos/icons generate:registry.`,
    );
  }
  return id;
}

export function isMirrored(name: string): boolean {
  return MIRRORED.has(lucideName(name));
}
