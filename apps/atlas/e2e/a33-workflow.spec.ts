import { expect, test } from "@playwright/test";
import { expectAccessibleInBothThemes, ORG, settled, signIn } from "./operations-support";

/**
 * A33 journeys on the demo tenant seed (0010, 0107, 0116 and 1030):
 *   approvals   a purchase order that Finance approved waits on the Owner, who approves it
 *   trash       a deleted template is restored from Trash
 *   templates   a project is created from a published template
 *   builder     a report is built, previewed and saved
 *   settings    approval policies and state labels show their panels
 * Every screen is checked with axe in both themes.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
expect.configure({ timeout: 20_000 });

test("approvals: the Owner decides the step a purchase order waits on", async ({ page }) => {
  await signIn(page, "owner@example.com");
  await page.goto(`/${ORG}/approvals`);
  await expect(page.getByRole("heading", { name: "Approvals", level: 1 })).toBeVisible();
  const item = page.getByRole("listitem").filter({ hasText: "Owner sign-off" }).first();
  await expect(item.getByText("waiting for a decision")).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await settled(page);
  await item.getByRole("button", { name: "Approve step" }).click();
  // The decided approval leaves the waiting list (and its confirmation with it, finding A24-001).
  await expect(page.getByRole("link", { name: /^Waiting on me 0$/ })).toBeVisible();
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "Owner sign-off" })
      .getByText("waiting for a decision"),
  ).toHaveCount(0);
});

test("trash: a deleted template comes back", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto(`/${ORG}/trash?table=templates`);
  await expect(page.getByRole("heading", { name: "Trash", level: 1 })).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await settled(page);
  await page.getByRole("button", { name: "Restore Winter Gala Format" }).click();
  // The restored row leaves Trash (and its confirmation with it, finding A24-001).
  await expect(page.getByRole("button", { name: "Restore Winter Gala Format" })).toHaveCount(0);
});

test("templates: a project is created from the published template", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto(`/${ORG}/projects/templates`);
  await page.getByRole("link", { name: /Weekend Festival/ }).click();
  await expect(page.getByRole("heading", { name: "Weekend Festival" })).toBeVisible();
  await expectAccessibleInBothThemes(page);
  const key = `W${String.fromCharCode(65 + (Date.now() % 26))}${String.fromCharCode(65 + (Math.floor(Date.now() / 26) % 26))}`;
  const form = page.getByRole("form", { name: "Create a project from this template" });
  await form.getByLabel("Project key").fill(key);
  await form.getByLabel("Project name").fill(`Template Weekend ${key}`);
  await form.getByLabel("Start date").fill("2027-08-14");
  await settled(page);
  await form.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByText(`Project ${key} created.`)).toBeVisible();
});

test("report builder: build, preview and save a report", async ({ page }) => {
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/reports/builder`);
  await expect(page.getByRole("heading", { name: "Report builder", level: 1 })).toBeVisible();
  // The name field is controlled; typing before hydration would be discarded.
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Report name").fill(`Records by state ${Date.now().toString(36)}`);
  await page.getByLabel("Group by").selectOption("record_state");
  await page.getByLabel("Summary").first().selectOption("Count");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("table", { name: "Report preview" })).toBeVisible();
  // Save before the theme checks: they reload the page, which drops an unsaved draft.
  await page.getByRole("button", { name: "Save report" }).click();
  await page.waitForURL(/report=/);
  await expectAccessibleInBothThemes(page);
});

test("settings: approval policies and state labels", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto(`/${ORG}/settings/approval-policies`);
  await expect(page.getByRole("heading", { name: "Approval policies", level: 2 })).toBeVisible();
  await expect(page.getByText("Step 2: Owner sign-off", { exact: false })).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await page.goto(`/${ORG}/settings/views-and-defaults`);
  await expect(page.getByRole("heading", { name: "Record state labels" })).toBeVisible();
  await expectAccessibleInBothThemes(page);
});
