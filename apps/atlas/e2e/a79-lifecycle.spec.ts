import type { Page } from "@playwright/test";
import { expect as baseExpect, settledGoto, test } from "./engine-test";
import { failPayment, stepUp } from "./a79-support";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A79 journeys (Section 14.7 and Section 16): the trial countdown, deletion with its 7-day recovery
 * window, ownership transfer with step-up on both sides, and the dunning banner. Each runs on a fresh org so
 * the demo tenant stays live. A refused step-up opens A77's step-up dialog; the journeys check it opens, cancel
 * it, and pass the second factor through Supabase Auth (a79-support.ts).
 */

const STEP_UP = "Confirm it is you with your second factor, then try again.";

/**
 * Every lifecycle step is a server action that checks the second factor, calls an RPC and renders the org's banners
 * again; on a loaded machine one takes longer than Playwright's 5-second default, so these assertions wait 30.
 */
const expect = baseExpect.configure({ timeout: 30_000 });

/** A77's step-up dialog, which asks a person with no second factor to set one up. */
async function cancelStepUpDialog(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Set up a second factor" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
}

test("a new org shows its Pro trial countdown and where to add a card", async ({ page }) => {
  const id = uniqueId();
  const slug = `trial-${id}`;
  await signUp(page, { name: "Tara Trial", email: testEmail("trial", id) });
  await createOrganization(page, { name: `Trial Co ${id}`, slug });

  const banner = page.getByTestId("trial-banner");
  await expect(banner).toContainText("14 days left in your Pro trial.");
  await expect(banner).toContainText(`Trial Co ${id} moves to the Access plan`);
  await expect(page.getByText(`Trial Co ${id} is on a Pro trial until`)).toBeVisible();
  await expectAccessible(page);

  await banner.getByRole("link", { name: "Add a card" }).click();
  await page.waitForURL(`**/${slug}/settings/billing-and-plan`);
  const notice = page.getByTestId("billing-lifecycle");
  await expect(notice.getByRole("heading", { name: "Pro trial" })).toBeVisible();
  await expect(notice).toContainText("14-day Pro trial");
  await expectAccessible(page);
});

test("deleting an org needs step-up, makes it read-only and can be recovered within 7 days", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const id = uniqueId();
  const slug = `delete-${id}`;
  const name = `Ending Co ${id}`;
  const email = testEmail("deleter", id);
  await signUp(page, { name: "Dee Deleter", email });
  await createOrganization(page, { name, slug });

  await page.goto(`/${slug}/settings/danger-zone`);
  const form = page.getByRole("form", { name: "Delete the organization" });
  await form.getByLabel(`Type ${name} to confirm deletion`).fill(name);
  await form.getByLabel("Why are you deleting it?").fill("The tour is over.");
  await form.getByRole("button", { name: "Delete the organization" }).click();
  await expect(form.getByText(STEP_UP)).toBeVisible();
  await cancelStepUpDialog(page);
  await expectAccessible(page);

  // Pass the second factor, then ask again.
  await stepUp(page, email);
  await page.reload();
  const again = page.getByRole("form", { name: "Delete the organization" });
  await again.getByLabel(`Type ${name} to confirm deletion`).fill(name);
  await again.getByLabel("Why are you deleting it?").fill("The tour is over.");
  await again.getByRole("button", { name: "Delete the organization" }).click();
  await expect(page.getByTestId("deletion-banner")).toContainText("will be deleted after");
  await expect(page.getByText("Waiting to be deleted")).toBeVisible();
  await expectAccessible(page);

  // Read-only everywhere until then.
  await page.goto(`/${slug}/settings/custom-objects`);
  await expect(page.getByTestId("deletion-banner")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Read Only Probe");
  await page.getByRole("button", { name: "Define the object" }).click();
  await expect(page.getByText("This organization is read-only")).toBeVisible();

  // Recover within the window.
  await page.goto(`/${slug}/settings/danger-zone`);
  await page.getByRole("button", { name: "Recover the organization" }).click();
  await expect(page.getByTestId("deletion-banner")).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Delete the organization" })).toBeVisible();
});

test("ownership moves to a member who accepts with step-up; the old Owner becomes an Admin", async ({
  page,
  browser,
}) => {
  test.setTimeout(200_000);
  const id = uniqueId();
  const slug = `handover-${id}`;
  const ownerEmail = testEmail("owner", id);
  const heirEmail = testEmail("heir", id);
  await signUp(page, { name: "Olive Owner", email: ownerEmail });
  await createOrganization(page, { name: `Handover ${id}`, slug });

  // Invite the member who will take over.
  await page.goto(`/${slug}/settings/members`);
  await page.getByLabel("Email", { exact: true }).fill(heirEmail);
  await page.getByRole("button", { name: "Create invite" }).click();
  const link = page.getByRole("textbox", { name: "Invitation link", exact: true });
  await expect(link).toHaveValue(/\/auth\/invite\/xinv_/);
  const inviteUrl = new URL(await link.inputValue());
  const heir = settledGoto(await (await browser.newContext()).newPage());
  await heir.goto(inviteUrl.pathname);
  await heir.getByLabel(/^Full name$/).fill("Hal Heir");
  await heir.locator("#signup-email").fill(heirEmail);
  await heir.locator("#signup-password").fill(`E2e-${"passphrase"}-9431`);
  await heir.getByRole("button", { name: "Create account" }).click();
  await heir.getByRole("button", { name: "Accept invitation" }).click();
  await heir.waitForURL(`**/${slug}/home`);

  // The Owner offers the org: step-up first.
  await page.goto(`/${slug}/settings/danger-zone`);
  const offer = page.getByRole("form", { name: "Transfer ownership" });
  await offer.getByRole("button", { name: "Offer ownership" }).click();
  await expect(offer.getByText(STEP_UP)).toBeVisible();
  await cancelStepUpDialog(page);
  await stepUp(page, ownerEmail);
  await page.reload();
  await page
    .getByRole("form", { name: "Transfer ownership" })
    .getByRole("button", { name: "Offer ownership" })
    .click();
  await expect(page.getByTestId("ownership-offer-open")).toContainText("Offered to Hal Heir");
  await expectAccessible(page);

  // The member sees the offer in the org banner and accepts with their second factor.
  await heir.goto(`/${slug}/home`);
  const banner = heir.getByTestId("ownership-offer-banner");
  await expect(banner).toContainText("Olive Owner offered you ownership");
  await expectAccessible(heir);
  await banner.getByRole("button", { name: "Accept ownership" }).click();
  await expect(heir.getByText(STEP_UP)).toBeVisible();
  await cancelStepUpDialog(heir);
  await stepUp(heir, heirEmail);
  await heir.reload();
  await heir
    .getByTestId("ownership-offer-banner")
    .getByRole("button", { name: "Accept ownership" })
    .click();
  await expect(heir.getByTestId("ownership-offer-banner")).toHaveCount(0);

  // The new Owner reaches the Owner's controls; the old Owner is an Admin and no longer offers the org.
  await heir.goto(`/${slug}/settings/danger-zone`);
  await expect(heir.getByRole("form", { name: "Delete the organization" })).toBeVisible();
  await page.goto(`/${slug}/settings/danger-zone`);
  await expect(page.getByText("Only the Owner transfers ownership.")).toBeVisible();
  await page.goto(`/${slug}/settings/members`);
  await expect(page.getByText("Hal Heir", { exact: true })).toBeVisible();
});

test("a failed payment shows the dunning banner with the way to fix billing", async ({ page }) => {
  const id = uniqueId();
  const slug = `dunning-${id}`;
  await signUp(page, { name: "Bill Payer", email: testEmail("payer", id) });
  await createOrganization(page, { name: `Overdue Co ${id}`, slug });

  // A Stripe webhook reports the payment failed.
  await failPayment(slug);
  await page.goto(`/${slug}/home`);
  const banner = page.getByTestId("dunning-banner");
  await expect(banner).toContainText("A payment failed today.");
  await expect(banner).toContainText("to keep full access");
  await expectAccessible(page);
  await banner.getByRole("link", { name: "Update the payment method" }).click();
  await page.waitForURL(`**/${slug}/settings/billing-and-plan`);
  const notice = page.getByTestId("billing-lifecycle");
  await expect(notice.getByRole("heading", { name: "Payment overdue" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Update the payment method" })).toBeVisible();
  await expectAccessible(page);
});
