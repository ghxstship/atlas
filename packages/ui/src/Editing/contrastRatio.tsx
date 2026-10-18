import { ratio } from "@xos/tokens/ratio";

/** WCAG 2.2 contrast ratio between two hex colors: the @xos/tokens contrast gate arithmetic itself. */
export function contrastRatio(a: string, b: string): number {
  return ratio(a, b);
}
