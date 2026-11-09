import type { Database } from "./database.types.ts";

/**
 * How a day type reads (B4, G-38): a categorical colour step and an icon beside its text, and its catalog slug. A
 * module of its own, free of the generated enum constants, so client code that only draws day types stays small.
 */

type DayType = Database["app"]["Enums"]["project_day_type"];

/** A categorical colour step (viz-cat-1 to viz-cat-7) and an icon, so a day type never reads by colour alone. */
export interface DayTypeTone {
  readonly category: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly icon: string;
}

const TONES: Readonly<Record<DayType, DayTypeTone>> = {
  "Load In": { category: 1, icon: "Truck" },
  Show: { category: 2, icon: "Ticket" },
  "Load Out": { category: 3, icon: "Package" },
  Travel: { category: 4, icon: "Plane" },
  Off: { category: 5, icon: "Palmtree" },
  Rehearsal: { category: 6, icon: "Clapperboard" },
  Other: { category: 7, icon: "Circle" },
};

export function dayTypeTone(type: DayType): DayTypeTone {
  return TONES[type];
}

/** Catalog slug of a day type, for copy keys (`schedule.days.types.loadIn`). */
export function dayTypeSlug(type: DayType): string {
  return type
    .split(" ")
    .map((w, i) => (i === 0 ? w.toLowerCase() : w))
    .join("");
}
