import type { HireWarning } from "@xos/data/procurement";

/**
 * The catalog key of each delivery and return window warning (R7a, G-99): `procurement.hireWarnings.<key>`.
 * Warnings never refuse a line; the order page shows them as chips and the line form as a notice.
 */
export const HIRE_WARNING_KEY: Record<HireWarning, string> = {
  "Delivery After Load In": "deliveryAfterLoadIn",
  "Return Before Load Out": "returnBeforeLoadOut",
  "Hire Beyond Site Window": "hireBeyondSiteWindow",
  "Delivery Docks Full": "deliveryDocksFull",
  "Return Docks Full": "returnDocksFull",
};

/** Asset tags typed one per line (or separated by commas), trimmed, blanks dropped. */
export function tagsOf(raw: string | null): string[] {
  return (raw ?? "")
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
