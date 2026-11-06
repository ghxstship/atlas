/**
 * The equipment block a person pastes into quick add (B11, G-107): one item per line, as vendors and riders write them,
 * in English and Spanish. It reads "12 x SM58", "12x SM58", "SM58 x 12", "12 SM58", "SM58 (12)", "qty 4 truss",
 * "SM58<tab>12", "12 ea SM58" and "12 unidades de SM58", with bullets stripped. A line ending in a colon is a group
 * heading, not an item. A line with no quantity reads as 1 and says so, so the preview can flag it. Pure: a server action
 * resolves the names and the person confirms before anything is written.
 */

export interface EquipmentLine {
  /** The line as written in the block, 1 first. */
  readonly lineNumber: number;
  readonly quantity: number;
  /** True when the line named no quantity, so 1 is a guess. */
  readonly quantityAssumed: boolean;
  readonly item: string;
  /** The heading above it, when a line ending in a colon set one. */
  readonly group: string | null;
}

export type EquipmentParse =
  | { readonly ok: true; readonly lines: readonly EquipmentLine[] }
  | { readonly ok: false; readonly code: "equipment_too_many" };

/** The most lines one block takes; app.add_procurement_needs and app.add_po_lines refuse above it too. */
export const EQUIPMENT_LINE_LIMIT = 200;

const BULLET = /^\s*(?:[-*•·–—]|\d+[.)])\s+/u;
const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const UNIT = String.raw`(?:ea|each|pcs?|pieces?|units?|uds?|unidad(?:es)?|piezas?)\.?`;
const X = String.raw`[x×]`;

const PATTERNS: readonly { readonly re: RegExp; readonly quantity: number; readonly item: number }[] = [
  // SM58<tab>12
  { re: new RegExp(String.raw`^(.+?)\t+\s*(${NUMBER})\s*$`, "iu"), quantity: 2, item: 1 },
  // 12<tab>SM58
  { re: new RegExp(String.raw`^(${NUMBER})\s*\t+\s*(.+)$`, "iu"), quantity: 1, item: 2 },
  // qty 4 truss, cant. 4 truss, cantidad 4 truss
  {
    re: new RegExp(String.raw`^(?:qty|quantity|cant\.?|cantidad)\s*:?\s*(${NUMBER})\s+(.+)$`, "iu"),
    quantity: 1,
    item: 2,
  },
  // 12 unidades de SM58, 12 ea SM58, 12 pcs of SM58
  {
    re: new RegExp(String.raw`^(${NUMBER})\s*${UNIT}\s+(?:(?:of|de)\s+)?(.+)$`, "iu"),
    quantity: 1,
    item: 2,
  },
  // 12 x SM58, 12x SM58
  { re: new RegExp(String.raw`^(${NUMBER})\s*${X}\s*(.+)$`, "iu"), quantity: 1, item: 2 },
  // SM58 x 12
  { re: new RegExp(String.raw`^(.+?)\s+${X}\s*(${NUMBER})$`, "iu"), quantity: 2, item: 1 },
  // SM58 (12)
  { re: new RegExp(String.raw`^(.+?)\s*\(\s*(${NUMBER})\s*\)$`, "iu"), quantity: 2, item: 1 },
  // 12 SM58
  { re: new RegExp(String.raw`^(${NUMBER})\s+(.+)$`, "iu"), quantity: 1, item: 2 },
];

function quantityOf(text: string): number {
  return Number(text.replace(",", "."));
}

/** One line of a block as an item, or null for a blank line. Headings are read by parseEquipmentBlock. */
function readLine(raw: string): { quantity: number; quantityAssumed: boolean; item: string } | null {
  const line = raw.replace(BULLET, "").replace(/\s+$/u, "");
  if (line.trim() === "") return null;
  for (const pattern of PATTERNS) {
    const hit = pattern.re.exec(line.trim());
    const quantity = hit?.[pattern.quantity];
    const item = hit?.[pattern.item]?.trim();
    if (quantity && item && quantityOf(quantity) > 0)
      return { quantity: quantityOf(quantity), quantityAssumed: false, item };
  }
  return { quantity: 1, quantityAssumed: true, item: line.trim() };
}

export function parseEquipmentBlock(text: string): EquipmentParse {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  if (raw.filter((l) => l.trim() !== "").length > EQUIPMENT_LINE_LIMIT)
    return { ok: false, code: "equipment_too_many" };
  const lines: EquipmentLine[] = [];
  let group: string | null = null;
  raw.forEach((line, index) => {
    const trimmed = line.replace(BULLET, "").trim();
    if (trimmed === "") return;
    if (trimmed.endsWith(":")) {
      group = trimmed.slice(0, -1).trim() || null;
      return;
    }
    const read = readLine(line);
    if (read) lines.push({ lineNumber: index + 1, group, ...read });
  });
  return { ok: true, lines };
}
