import { expect, test } from "@playwright/test";
import { expectAccessibleInBothThemes, newOperator, signInOperator, sql } from "./support";

/**
 * Platform metrics (A137, RRR-200, trace row S4.10-09): every operator role opens Metrics from the top bar and sees
 * each figure group, read from the database through app.console_platform_metrics. The live org count matches the
 * database; the RPC itself refuses anyone off the platform team (pgTAP 2300).
 */

const GROUPS = [
  "Growth",
  "Active people",
  "Plans and trials",
  "Usage",
  "Aurora",
  "Job queue",
  "Notification delivery",
] as const;

test("Trust and Safety opens Metrics and sees every figure group", async ({ page }) => {
  const email = await newOperator("Trust and Safety", "Theo Metrics");
  await signInOperator(page, email);
  await page
    .getByRole("navigation", { name: "Console" })
    .getByRole("link", { name: "Metrics" })
    .click();
  await page.waitForURL("**/metrics");
  await expect(page.getByRole("heading", { level: 1, name: "Platform Metrics" })).toBeVisible();
  for (const group of GROUPS) {
    await expect(page.getByRole("heading", { level: 2, name: group, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId("metrics-generated")).toContainText("UTC");

  const [row] = await sql<{ live: string }>(
    `select count(*)::text as live from app.organizations where deleted_at is null`,
  );
  const live = new Intl.NumberFormat("en-US").format(Number(row?.live ?? 0));
  await expect(page.getByRole("region", { name: "Live orgs" })).toContainText(live);
  await expect(
    page.getByTestId("metrics-plans").getByRole("rowheader", { name: "Access" }),
  ).toBeVisible();
  await expect(
    page.getByTestId("metrics-notifications").getByRole("rowheader", { name: "Email" }),
  ).toBeVisible();
  await expectAccessibleInBothThemes(page);
});

test("Support reads the same page directly", async ({ page }) => {
  const email = await newOperator("Support", "Sia Metrics");
  await signInOperator(page, email, "/metrics");
  await expect(page.getByRole("heading", { level: 1, name: "Platform Metrics" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Active in the last 30 days" })).toBeVisible();
});
