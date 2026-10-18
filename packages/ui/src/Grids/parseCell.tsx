import type { GridColumn } from "../types/reference";
import { isNumeric } from "./Grids.shared.tsx";
import { type Cell } from "./Grids.types.ts";

/** A typed cell value: blank is null, numbers parse (a trailing x on multipliers is dropped), text stays text. */
export function parseCell(c: GridColumn, text: string): Cell {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!isNumeric(c)) return trimmed;
  const n = Number(trimmed.replace(/x$/i, "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
