import type { GridColumn } from "../types/reference";

export function isNumeric(c: GridColumn): boolean {
  return c.type === "money" || c.type === "number" || c.type === "multiplier";
}
