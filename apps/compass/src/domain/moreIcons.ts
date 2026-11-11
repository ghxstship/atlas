/**
 * The icon on each More menu row, by menu id. Every entry Compass renders itself (NATIVE_MORE) has one; a row
 * without one fell back to a chevron in the icon slot, as Drives did (C-21).
 */
export const MORE_ICONS: Readonly<Record<string, string>> = {
  incidents: "shield-alert",
  inspections: "clipboard-check",
  logistics: "package",
  "logistics.gate": "truck",
  show: "clapperboard",
  "run-of-show": "clapperboard",
  reference: "book-open",
  "offline-queue": "refresh-cw",
  profile: "user",
  settings: "settings",
  expenses: "receipt",
  timesheets: "clock",
  "per-diem": "banknote",
  "travel-and-lodging": "plane",
  onboarding: "list-checks",
  "purchase-orders": "file-text",
  deliveries: "truck",
  submittals: "file-check",
  "time-entries": "clock",
  deliverables: "file-check",
  "advance-summary": "clipboard-list",
  rider: "clipboard-list",
  settlement: "banknote",
  reports: "chart-column",
  "proof-of-performance": "megaphone",
  "project-details": "clipboard-list",
  // B5: the transfers the person drives.
  drives: "navigation",
};

/** The row's icon; "file-text" for an id the table has not caught up with, never a chevron. */
export function moreIcon(id: string): string {
  return MORE_ICONS[id] ?? "file-text";
}
