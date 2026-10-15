import { lucideName, resolveIcon as resolveRegisteredIcon } from "@xos/icons";
import type { IconComponent } from "@xos/icons";

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

const warned = new Set<string>();

/**
 * Resolves an icon from the @xos/icons registry, the closed set that keeps lucide-react tree-shaken
 * (RRR-70). Returns null for a name outside the registry and warns once per name so the
 * missing name is added to the owner's registry list rather than shipping a blank square.
 */
export function resolveIcon(name: string): IconComponent | null {
  const icon = resolveRegisteredIcon(name);
  if (icon === null && !warned.has(name)) {
    warned.add(name);
    console.warn(
      `@xos/ui Icon: "${name}" is not in the @xos/icons registry. Add ${lucideName(name)} to packages/icons/registry/<owner>.txt and run pnpm --filter @xos/icons generate:registry.`,
    );
  }
  return icon;
}

export function isMirrored(name: string): boolean {
  return MIRRORED.has(lucideName(name));
}
