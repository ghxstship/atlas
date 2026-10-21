import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { expectAccessibleInBothThemes } from "./a16-support";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";
import { enrollAuthenticator } from "./totp";

/**
 * Journey 39 (Section 20.2, Section 14.7): an Owner downloads the full export, cancels the org by
 * typing its name, sees the read-only banner during the 30-day window, finds writes refused, downloads
 * the export again, and reactivates. Runs on a fresh org so the demo tenant stays live.
 */
test("journey 39: cancel an org, download the full export, read-only banner", async ({ page }) => {
  test.setTimeout(150_000);
  const id = uniqueId();
  const slug = `cancel-${id}`;
  const name = `Closing Co ${id}`;
  await signUp(page, { name: "Olive Owner", email: testEmail("owner", id) });
  await createOrganization(page, { name, slug });

  await page.goto(`/${slug}/settings/danger-zone`);
  const panel = page.getByRole("region", { name: "Cancel the organization" });
  await expect(panel).toBeVisible();
  await expectAccessibleInBothThemes(page);
  // The theme check ends on a reload; the link opens the step-up dialog only once the page is live.
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });

  // The full export: one ZIP with a manifest. It needs step-up (Section 9, A77): a new Owner sets up a
  // second factor in the step-up dialog, and the download follows.
  await panel.getByRole("link", { name: "Download the full export" }).click();
  const [download] = await Promise.all([
    // Setting up the factor, verifying it and building the archive come before the file.
    page.waitForEvent("download", { timeout: 60_000 }),
    enrollAuthenticator(page.getByRole("dialog", { name: "Set up a second factor" })),
  ]);
  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^${slug}-export-\\d{4}-\\d{2}-\\d{2}\\.zip$`),
  );
  const archive = await readFile((await download.path()) as string);
  expect(archive.readUInt32LE(0)).toBe(0x04034b50);
  expect(archive.includes(Buffer.from("manifest.json"))).toBe(true);
  expect(archive.includes(Buffer.from("records/memberships.json"))).toBe(true);

  // A wrong name is refused and the typed reason stays.
  await panel.getByLabel(`Type ${name} to confirm`).fill("Closing Co");
  await panel.getByLabel("Why are you canceling?").fill("The season is over.");
  await panel.getByRole("button", { name: "Cancel the organization" }).click();
  await expect(
    panel.getByText("Type the organization's name exactly as shown to confirm."),
  ).toBeVisible();
  await expect(panel.getByLabel("Why are you canceling?")).toHaveValue("The season is over.");

  // Cancel: the org turns read-only for 30 days.
  await panel.getByLabel(`Type ${name} to confirm`).fill(name);
  await panel.getByRole("button", { name: "Cancel the organization" }).click();
  await expect(page.getByText("Canceled and read-only").first()).toBeVisible();
  await expect(page.getByTestId("read-only-banner")).toContainText("read-only for 30 more days");

  // The banner shows on every page, and writes are refused.
  await page.goto(`/${slug}/home`);
  await expect(page.getByTestId("read-only-banner")).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await page.goto(`/${slug}/settings/custom-objects`);
  await page.getByLabel("Name", { exact: true }).fill("Read Only Probe");
  await page.getByRole("button", { name: "Define the object" }).click();
  await expect(page.getByText("This organization is canceled and read-only.")).toBeVisible();

  // The export stays available during the window.
  await page.goto(`/${slug}/settings/danger-zone`);
  const [again] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download the full export" }).click(),
  ]);
  expect(again.suggestedFilename()).toMatch(/\.zip$/);
  await expect(page.getByText(/tables, \d+ rows, \d+ files/).first()).toBeVisible();

  // Reactivate within the window: the banner leaves.
  await page.getByRole("button", { name: "Reactivate on the Access plan" }).click();
  await expect(page.getByTestId("read-only-banner")).toHaveCount(0);
});
