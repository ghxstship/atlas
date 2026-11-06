import { expect, test } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * B2 Outside access (RRR-226, ADR 0141; gap G-81): the section on Project Settings, its first click on a just-loaded page
 * opens the dialog, an intake link's code stays through a refresh until dismissed, and Regenerate and Revoke change the row.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

test("Outside access lists a link, regenerates with the code still showing, and revokes", async ({
  page,
}) => {
  const id = uniqueId();
  const slug = `b2a-${id}`;
  await signUp(page, { name: "Ana Access", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Access ${id}`, slug });
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const create = page.getByRole("dialog", { name: "New project" });
  await create.getByLabel("Project key").fill("SHW");
  await create.getByLabel("Project name").fill("Summer Headline Weekend");
  await create.getByRole("button", { name: "More fields" }).click();
  await create.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await create.getByLabel("Tier of experience").selectOption({ index: 5 });
  await create.getByLabel("First production day").fill("2027-03-12");
  await create.getByLabel("Last production day").fill("2027-03-15");
  await create.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/SHW/overview`);

  await page.goto(`/${slug}/p/SHW/settings#outside-access`);
  const section = page.locator("#outside-access");
  await expect(section.getByText("Nothing reaches this project from outside yet.")).toBeVisible();

  await expect(async () => {
    await section.getByRole("button", { name: "New intake link", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
  }).toPass();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title", { exact: true }).fill(`Audio vendors ${id}`);
  await dialog.getByLabel("Who engages").selectOption("Contractor");
  await dialog.getByLabel("Start date").fill("2027-03-12");
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  await dialog.getByLabel("Role", { exact: true }).selectOption({ index: 1 });
  await dialog.getByLabel("Classification").selectOption({ index: 1 });
  await dialog.getByLabel("Pay basis").selectOption({ index: 1 });
  await dialog.getByLabel("Arrangement").selectOption({ index: 1 });
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  const expires = await dialog.getByLabel("Available until").getAttribute("max");
  await dialog.getByLabel("Available until").fill(expires as string);
  await dialog.getByRole("button", { name: "Create link" }).click();

  const panel = page.locator("[data-outside-reveal]");
  await expect(panel).toBeVisible();
  const first = await panel.getByRole("textbox", { name: "Access code" }).inputValue();
  expect(first).toMatch(/^[0-9]{6}$/);
  expect(await panel.getByRole("textbox", { name: "Link" }).inputValue()).toMatch(
    /\/onboard\/xvin_[0-9a-f]{64}$/,
  );

  const row = section.locator('[data-outside-row="Intake link"]');
  await expect(row).toContainText(`Audio vendors ${id}`);
  await row.getByRole("button", { name: "Regenerate", exact: true }).click();
  await row.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "Access code" })).not.toHaveValue(first);
  // The router refreshed the row; the panel lives above the list and is still there.
  await expect(panel).toBeVisible();

  await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(panel).toHaveCount(0);

  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await row.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(row).toContainText("Revoked");
  await expect(row.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);
});
