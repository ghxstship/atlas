import { expect, test } from "./engine-test";
import {
  createOrganization,
  expectAccessible,
  openChoices,
  signUp,
  testEmail,
  uniqueId,
} from "./support";

/**
 * Notification settings (A80, RRR-125, finding A65-021): an Owner sets the org's defaults and makes
 * Safety mandatory on Settings, Notifications (Section 4.5.6 item 29); on Personal settings,
 * Notifications the member sees those defaults, cannot turn a locked channel off, and saves their own
 * choices, quiet hours and digest (item 8). Both pages render axe clean. Each category is a closed group
 * naming its channels (gate 27), opened to change them.
 */
test("org notification defaults and the personal preference matrix", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const id = uniqueId();
  const slug = `notify-${id}`;
  await signUp(page, { name: "Nora Notify", email: testEmail("notify", id) });
  await createOrganization(page, { name: `Notify ${id}`, slug });

  // Settings, Notifications: the org's defaults and mandatory categories.
  await page.goto(`/${slug}/settings/notifications`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  const org = page.getByRole("form", { name: "Organization notification defaults" });
  await expect(org.getByRole("heading", { name: "Defaults for members" })).toBeVisible();
  await expectAccessible(page);
  await expect(org.locator("summary").filter({ hasText: "Feed" })).toContainText("In app, Email");
  await openChoices(org, "Feed");
  await openChoices(org, "Safety");
  const feedEmail = org.getByRole("checkbox", { name: "Feed by Email", exact: true });
  await expect(feedEmail).toBeChecked();
  await feedEmail.uncheck();
  await org.getByRole("checkbox", { name: "Safety by Text (SMS)", exact: true }).check();
  await org.getByRole("checkbox", { name: "Safety is mandatory" }).check();
  // The closed summaries follow the boxes.
  await expect(org.locator("summary").filter({ hasText: "Feed" })).not.toContainText("Email");
  await expect(org.locator("summary").filter({ hasText: "Safety" })).toContainText("Mandatory");
  await org.getByRole("button", { name: "Save notification settings" }).click();
  await expect(org.getByRole("status")).toHaveText("Notification settings saved.", {
    timeout: 20_000,
  });

  await page.reload();
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  await openChoices(page, "Feed");
  await openChoices(page, "Safety");
  await expect(
    page.getByRole("checkbox", { name: "Feed by Email", exact: true }),
  ).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Safety is mandatory" })).toBeChecked();

  // Personal settings, Notifications: the member's matrix follows the org.
  await page.goto(`/${slug}/me/notifications`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  const mine = page.getByRole("form", { name: "Your notification settings" });
  await expect(mine.getByRole("heading", { name: "What reaches you" })).toBeVisible();
  // Texts need a verified phone before consent can be given (Section 14.5).
  await expect(
    mine.getByText("Add and verify a phone number on your account to receive texts."),
  ).toBeVisible();
  await expectAccessible(page);
  await openChoices(mine, "Feed");
  await openChoices(mine, "Safety");
  await openChoices(mine, "Mentions");
  await expect(
    mine.getByRole("checkbox", { name: "Feed by Email", exact: true }),
  ).not.toBeChecked();
  const lockedPush = mine.getByRole("checkbox", {
    name: "Safety by Push. Required by your organization",
  });
  await expect(lockedPush).toBeChecked();
  await expect(lockedPush).toBeDisabled();
  await expect(
    mine.getByRole("checkbox", { name: "Safety by Text (SMS). Required by your organization" }),
  ).toBeDisabled();

  await mine.getByRole("checkbox", { name: "Mentions by Push", exact: true }).uncheck();
  await mine.getByRole("checkbox", { name: "Feed by Email", exact: true }).check();
  await mine.getByLabel("Quiet hours start").fill("22:00");
  await mine.getByLabel("Quiet hours end").fill("07:00");
  await mine.getByLabel("Time zone").selectOption("America/Chicago");
  await mine.getByLabel("Email digest").selectOption("Daily");
  await mine.getByRole("button", { name: "Save notification settings" }).click();
  await expect(mine.getByRole("status")).toHaveText("Notification settings saved.", {
    timeout: 20_000,
  });

  await page.reload();
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  const saved = page.getByRole("form", { name: "Your notification settings" });
  await openChoices(saved, "Feed");
  await openChoices(saved, "Mentions");
  await expect(
    saved.getByRole("checkbox", { name: "Mentions by Push", exact: true }),
  ).not.toBeChecked();
  await expect(saved.getByRole("checkbox", { name: "Feed by Email", exact: true })).toBeChecked();
  await expect(saved.getByLabel("Quiet hours start")).toHaveValue("22:00");
  await expect(saved.getByLabel("Time zone")).toHaveValue("America/Chicago");
  await expect(saved.getByLabel("Email digest")).toHaveValue("Daily");

  // Quiet hours need both ends.
  await saved.getByLabel("Quiet hours end").fill("");
  await saved.getByRole("button", { name: "Save notification settings" }).click();
  await expect(
    saved.getByText("Set both the start and the end of quiet hours, or neither."),
  ).toBeVisible({ timeout: 20_000 });
});
