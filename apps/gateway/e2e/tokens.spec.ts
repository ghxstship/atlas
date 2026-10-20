import { expect, test } from "./engine-test";
import { issueAdvanceLink, issueSigningLink } from "./fixtures";
import {
  DEMO_PASSWORD,
  expectAccessible,
  expectAccessibleInBothThemes,
  reloadSettled,
} from "./support";

/**
 * Token flows without an account (Section 4.4.6; Section 20.2, journeys 9 and 50): a signing link
 * and an advance link, each opened by its six-digit access code, then the offer to claim what was
 * submitted into a Gateway account with the same email.
 */
function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

test("a signing link opens with its code and signs once", async ({ page }) => {
  const link = await issueSigningLink();
  await page.goto(`/sign/${link.token}`);
  await expect(page.getByRole("heading", { level: 1, name: "Review and sign" })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  await page.getByLabel("Access code").fill(wrongCode(link.code));
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByText(/That access code does not match/)).toBeVisible();

  await page.getByLabel("Access code").fill(link.code);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByText(link.title)).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Type your full name to sign").fill("Demo Crew");
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(
    page.getByText("Signed by Demo Crew. The organization countersigns next."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Create account" })).toBeVisible();
  await expectAccessible(page);

  // The signature is final: the same link no longer offers to sign.
  await reloadSettled(page);
  await page.getByLabel("Access code").fill(link.code);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByText("Status: Signed")).toBeVisible();
  await expect(page.getByLabel("Type your full name to sign")).toHaveCount(0);
});

test("an advance link is answered section by section and claimed into the account", async ({
  page,
}) => {
  const link = await issueAdvanceLink();
  await page.goto(`/advance/${link.token}`);
  await expect(page.getByRole("heading", { level: 1, name: "Answer your advance" })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Access code").fill(link.code);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: link.title })).toBeVisible();
  await expect(page.getByText("2 sections left")).toBeVisible();
  await expectAccessibleInBothThemes(page);

  for (const [section, answer] of [
    ["1. Equipment", "Two chain hoists, spansets and my own harness."],
    ["2. Arrival", "June 3 at 18:00 by car; I will need a parking pass."],
  ] as const) {
    const item = page
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: section }) });
    await item.getByLabel("Your answer").fill(answer);
    await item.getByRole("button", { name: "Send answer" }).click();
    await expect(item.getByText("Answer sent. The organization reviews it next.")).toBeVisible();
  }
  await expect(page.getByText("Every section is answered")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your advance is complete" })).toBeVisible();

  await page.getByRole("link", { name: "I have an account" }).click();
  await expect(page).toHaveURL(/\/auth\/sign-in\?next=%2Fauth%2Fclaim/);
  await page.locator("#signin-email").fill("crew@example.com");
  // The password field appears on request: the sign-in link is the first choice (A59-025).
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(/\/auth\/claim$/);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Claim submissions" }).click();
  await expect(
    page.getByText(
      /^Done: \d+ advance answers? and \d+ signed documents? are now in your account\.$/,
    ),
  ).toBeVisible();
  await page.getByRole("link", { name: "Go to Home" }).click();
  await expect(page).toHaveURL(/\/home$/);
});
