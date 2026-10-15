import {
  BUDGET_LINE_TYPES,
  parseMoney,
  xyzFor,
  type BudgetLineInput,
  type BudgetLineType,
  type UridOption,
  type XyzTag,
} from "@xos/data/finance";

/**
 * Parses rows pasted from a spreadsheet into budget lines (Section 20.2 journey 34). Columns, in
 * order: description, URID, quantity, unit price, then optionally line type, cost center code and
 * XYZ tag. A header row is skipped when its URID cell is not a URID. A blank price is unpriced and
 * stays NULL; a row that cannot be read is reported with the field at fault instead of guessed.
 */

export type PasteProblem =
  | "description"
  | "urid"
  | "quantity"
  | "unitPrice"
  | "lineType"
  | "costCenter"
  | "xyz";

export interface PasteResult {
  readonly lines: BudgetLineInput[];
  readonly problems: { readonly row: number; readonly field: PasteProblem }[];
  readonly unpricedCount: number;
}

const URID = /^\d{4}\.\d{2}(\.\d{2})?$/;

export function parsePastedLines(
  text: string,
  context: {
    readonly exponent: number;
    readonly urids: readonly UridOption[];
    readonly costCenters: readonly { readonly id: string; readonly code: string }[];
  },
): PasteResult {
  const rows = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.split("\t").map((cell) => cell.trim()))
    .filter((cells) => cells.some((c) => c !== ""));
  if (rows[0] && !URID.test(rows[0][1] ?? "")) rows.shift();
  const known = new Set(context.urids.map((u) => u.urid));
  const lines: BudgetLineInput[] = [];
  const problems: { row: number; field: PasteProblem }[] = [];
  let unpricedCount = 0;
  rows.forEach((cells, index) => {
    const row = index + 1;
    const [description = "", urid = "", qty = "", price = "", type = "", center = "", tag = ""] =
      cells;
    if (description === "") return void problems.push({ row, field: "description" });
    if (!known.has(urid)) return void problems.push({ row, field: "urid" });
    const quantity = qty === "" ? 1 : Number(qty.replace(/,/g, ""));
    if (!Number.isFinite(quantity) || quantity < 0) return void problems.push({ row, field: "quantity" });
    const unitPrice = parseMoney(price, context.exponent);
    if (unitPrice === "invalid" || (unitPrice !== null && unitPrice < 0))
      return void problems.push({ row, field: "unitPrice" });
    const lineType = (BUDGET_LINE_TYPES.find((t) => t.toLowerCase() === type.toLowerCase()) ??
      (type === "" ? "Cost" : null)) as BudgetLineType | null;
    if (!lineType) return void problems.push({ row, field: "lineType" });
    const costCenter =
      center === "" ? null : (context.costCenters.find((c) => c.code === center.toUpperCase()) ?? null);
    if (center !== "" && !costCenter) return void problems.push({ row, field: "costCenter" });
    const declared = tag === "" ? null : (tag.toUpperCase() as XyzTag);
    if (declared !== null && !["X", "Y", "Z"].includes(declared))
      return void problems.push({ row, field: "xyz" });
    const xyz = xyzFor(urid, context.urids, declared);
    if (!xyz) return void problems.push({ row, field: "xyz" });
    if (unitPrice === null) unpricedCount += 1;
    lines.push({
      description,
      lineType,
      urid,
      costCenterId: costCenter?.id ?? null,
      gradeCode: null,
      elementId: null,
      quantity,
      unitBasis: null,
      unitPriceMinor: unitPrice,
      ...xyz,
    });
  });
  return { lines, problems, unpricedCount };
}
