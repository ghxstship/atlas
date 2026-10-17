import { expect, test } from "@playwright/test";
import { expectAccessibleInBothThemes, ORG, settled, signIn } from "./operations-support";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * Saved views page (Section 11.15, A24-002): the Producer saves a view, finds it on /{org}/views
 * next to the Admin's shared "Active Projects", renames it, shares it with the org, opens it on its
 * collection's page and deletes it. Another member sees the shared view without owner actions. A
 * person with no views sees the empty state. Runs on the demo tenant seed.
 */

test.use({ reducedMotion: "reduce" });

test("the saved views page renames, shares, opens and deletes the viewer's views", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await signIn(page, "producer@example.com");
  const name = `Yard board ${Date.now().toString(36)}`;
  const renamed = `${name} renamed`;
  await page.goto(`/${ORG}/logistics/marshalling-yard-log?view=board&q=FL`);
  await page.getByRole("button", { name: /Saved views/ }).click();
  await page.getByRole("menuitem", { name: "Save current view" }).click();
  const save = page.getByRole("dialog", { name: "Save current view" });
  await save.getByLabel("Name").fill(name);
  await save.getByRole("button", { name: "Save view" }).click();
  await expect(save).toHaveCount(0);

  // The views menu leads to the page that manages them.
  await page.getByRole("button", { name }).click();
  await page.getByRole("menuitem", { name: "Manage saved views" }).click();
  await page.waitForURL(`**/${ORG}/views`);
  await expect(page.getByRole("heading", { level: 1, name: "Saved views" })).toBeVisible();
  const mine = page.getByRole("region", { name: "Your views" });
  const shared = page.getByRole("region", { name: "Shared with you" });
  await expect(mine.getByRole("link", { name })).toBeVisible();
  await expect(mine.getByText(/Only you/).first()).toBeVisible();
  await expect(shared.getByRole("link", { name: "Active Projects" })).toBeVisible();
  await expect(shared.getByRole("button", { name: /Delete Active Projects/ })).toHaveCount(0);
  await expectAccessibleInBothThemes(page);

  // Rename.
  await mine.getByRole("button", { name: `Rename ${name}` }).click();
  const rename = page.getByRole("dialog", { name: `Rename ${name}` });
  await rename.getByLabel("Name").fill(renamed);
  await settled(page);
  await rename.getByRole("button", { name: "Rename view" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: `Renamed to ${renamed}.` }),
  ).toBeVisible();
  await expect(mine.getByRole("link", { name: renamed })).toBeVisible();

  // Share with the organization.
  await mine.getByRole("button", { name: `Share ${renamed}` }).click();
  const share = page.getByRole("dialog", { name: `Share ${renamed}` });
  await share.getByLabel("Everyone in the organization").check();
  await share.getByRole("button", { name: "Save sharing" }).click();
  await expect(share).toHaveCount(0);
  const row = mine.getByRole("listitem").filter({ hasText: renamed });
  await expect(row.getByText(/Everyone in the organization/)).toBeVisible();

  // Another member sees it as shared, with no owner actions.
  const member = await (await browser.newContext()).newPage();
  await signIn(member, "admin@example.com");
  await member.goto(`/${ORG}/views`);
  const theirs = member.getByRole("region", { name: "Shared with you" });
  await expect(theirs.getByRole("link", { name: renamed })).toBeVisible();
  await expect(theirs.getByRole("button", { name: `Delete ${renamed}` })).toHaveCount(0);
  await member.close();

  // Opening it lands on its collection with its query.
  await mine.getByRole("link", { name: renamed }).click();
  await page.waitForURL(/marshalling-yard-log\?/);
  expect(new URL(page.url()).searchParams.get("q")).toBe("FL");

  // Delete.
  await page.goto(`/${ORG}/views`);
  await mine.getByRole("button", { name: `Delete ${renamed}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete view" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Deleted ${renamed}.` })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Saved views" })).toBeVisible();
  await expect(page.getByRole("link", { name: renamed })).toHaveCount(0);
});

test("the saved views page names the next step when there are none", async ({ page }) => {
  const id = uniqueId();
  const slug = `views-${id}`;
  await signUp(page, { name: "Vi Views", email: testEmail("views", id) });
  await createOrganization(page, { name: `Views ${id}`, slug });
  await page.goto(`/${slug}/views`);
  await expect(page.getByText(/No saved views yet/)).toBeVisible();
  await page.getByRole("button", { name: "Open Projects" }).click();
  await expect(page).toHaveURL(new RegExp(`/${slug}/projects`));
});
