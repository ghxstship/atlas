import { composite, ratio } from "@xos/tokens/ratio";

/** WCAG 2.2 contrast ratio between two hex colors: the @xos/tokens contrast gate arithmetic itself. */
export function contrastRatio(a: string, b: string): number {
  return ratio(a, b);
}

/** A fill with an overlay over it (a hover or pressed state), composited as the contrast gate does. */
export function overlaid(fill: string, overlay: string, opacity: number): string {
  return composite(fill, overlay, opacity);
}
