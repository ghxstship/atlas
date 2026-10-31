import { expect, test } from "@playwright/test";
import { expectAccessibleInBothThemes } from "./a16-support";
import { settle } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";

/**
 * Journey 32 (Section 20.2, Section 8.4): an Admin views Atlas as the Field role and sees nothing
 * beyond their own access (Field navigation, Field pages, the Admin's own rows), then ends the preview;
 * Why can I see this explains a record.
 */
test("journey 32: View as Field, and Why can I see this on a record", async ({ page }) => {
  await signInAs(page, "admin@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/settings/roles-and-capabilities`);
  const panel = page.getByRole("region", { name: "View as role" });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByLabel("Role", { exact: true }).locator("option", { hasText: "Owner" }),
  ).toHaveCount(0);
  await expectAccessibleInBothThemes(page);

  // Start the preview as Field (the crew band).
  await panel.getByLabel("Role", { exact: true }).selectOption({ label: "Field" });
  await panel.getByRole("button", { name: "Start the preview" }).click();
  await page.waitForURL(`**/${DEMO_ORG}/home`);
  await expect(
    page.getByText("Viewing as Field. You see nothing beyond your own access."),
  ).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // Field navigation: Commercial and Settings leave the sidebar, and their pages answer 404.
  await expect(page.getByRole("button", { name: "Commercial" })).toHaveCount(0);
  for (const hidden of [
    `/${DEMO_ORG}/finance/budgets`,
    `/${DEMO_ORG}/settings/members`,
    `/${DEMO_ORG}/import`,
  ]) {
    const response = await page.goto(hidden);
    expect(response?.status(), hidden).toBe(404);
  }

  // End the preview from the banner: the Admin's own navigation is back.
  await page.goto(`/${DEMO_ORG}/home`);
  await page.getByRole("button", { name: "End the preview" }).click();
  await page.waitForURL(`**/${DEMO_ORG}/settings/roles-and-capabilities`);
  await expect(page.getByText("Viewing as Field.")).toHaveCount(0);
  expect((await page.goto(`/${DEMO_ORG}/finance/budgets`))?.status()).toBe(200);

  // Why can I see this on a seeded Gear Requests record.
  await page.goto(`/${DEMO_ORG}/objects/gear_requests?view=list`);
  // The list streams in behind its skeleton and hydrates after the load event; an Open clicked
  // before then is lost (A71, A77).
  await settle(page);
  await page.getByRole("button", { name: "Open" }).first().click();
  const peek = page.getByRole("dialog");
  await peek.getByText("Why can I see this?").click();
  await expect(peek.getByText("Your membership and roles")).toBeVisible();
  await expect(peek.getByText("custom_object_records_read")).toBeVisible();
  await expectAccessibleInBothThemes(page);
});
