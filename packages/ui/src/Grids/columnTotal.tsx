import { type Row } from "./Grids.types.ts";

/** Column total, or null when any line is blank (the silence rule). */
export function columnTotal(rows: Row[], key: string): number | null {
  let sum = 0;
  let any = false;
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === undefined || v === "") return null;
    sum += Number(v);
    any = true;
  }
  return any ? sum : null;
}
