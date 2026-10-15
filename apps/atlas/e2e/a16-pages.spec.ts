import { expect, test } from "@playwright/test";
import { expectAccessibleInBothThemes, ORG, signIn } from "./a16-support";

/**
 * Every A16 page on the demo tenant renders its collection with the seeded rows, opens a peek and
 * the full record page, and is axe clean in both themes.
 */

test.use({ reducedMotion: "reduce" });

const PAGES: { path: string; heading: string; row?: string; noComments?: boolean }[] = [
  { path: "vendors/directory", heading: "Vendor directory", row: "Bayline Audio Rentals" },
  {
    path: "vendors/classes",
    heading: "Vendor classes",
    row: "Audio Rental Houses",
    noComments: true,
  },
  { path: "vendors/prequalification", heading: "Prequalification", row: "Flown line array" },
  {
    path: "vendors/insurance-certificates",
    heading: "Insurance certificates",
    row: "GL-2027-0042",
  },
  { path: "vendors/scorecards", heading: "Scorecards", row: "Demo Staging Supply" },
  {
    path: "vendors/sponsor-entitlements",
    heading: "Sponsor entitlements",
    row: "Logo on the main stage scrims.",
  },
  { path: "procurement/rfqs", heading: "Requests for quotation", row: "Main stage audio package" },
  { path: "procurement/purchase-orders", heading: "Purchase orders", row: "Demo Staging Supply" },
  { path: "procurement/receipts", heading: "Goods receipts", row: "Demo Staging Supply" },
  { path: "procurement/invoice-matching", heading: "Invoice matching" },
  { path: "procurement/catalog", heading: "Catalog", row: "DEMOPR" },
  {
    path: "knowledge/sops",
    heading: "Standard operating procedures",
    row: "Load-in and staging sequence",
  },
  { path: "knowledge/documents", heading: "Documents", row: "Bayfront Pier site safety plan" },
  {
    path: "knowledge/verbiage-library",
    heading: "Verbiage library",
    row: "Run of Show",
    noComments: true,
  },
  { path: "canon/departments", heading: "Departments", row: "1000", noComments: true },
  { path: "canon/disciplines", heading: "Disciplines", row: "Drone Light Shows", noComments: true },
  { path: "canon/categories", heading: "Categories", row: "1000.01.01", noComments: true },
  { path: "canon/elements", heading: "Elements", row: "0000", noComments: true },
  { path: "canon/phases-and-gates", heading: "Phases and gates", row: "SCP", noComments: true },
  { path: "canon/record-kinds", heading: "Record kinds", row: "Task", noComments: true },
  { path: "canon/roles", heading: "Roles", row: "1000", noComments: true },
  {
    path: "canon/jurisdictions-and-permit-rules",
    heading: "Jurisdictions and permit rules",
    row: "US-FL-MIAMI-DADE",
    noComments: true,
  },
  { path: "canon/metrics", heading: "Metrics", row: "", noComments: true },
  { path: "canon/org-extensions", heading: "Org extensions", row: "Drone Light Shows" },
];

for (const p of PAGES) {
  test(`${p.path} renders, peeks and opens the full page in both themes`, async ({ page }) => {
    await signIn(page);
    await page.goto(`/${ORG}/${p.path}`);
    await expect(page.getByRole("heading", { level: 1, name: p.heading })).toBeVisible();
    await expectAccessibleInBothThemes(page);
    if (p.row === undefined) return;
    await page.goto(`/${ORG}/${p.path}?view=list`);
    const row = page.getByRole("row").filter({ hasText: p.row }).first();
    await row.getByRole("button", { name: "Open" }).click();
    const peek = page.getByRole("dialog");
    await expect(peek).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page.getByRole("dialog").getByRole("link", { name: "Open full page" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    if (!p.noComments) {
      await expect(page.getByRole("heading", { level: 2, name: "Comments" })).toBeVisible();
    }
    await expectAccessibleInBothThemes(page);
  });
}
