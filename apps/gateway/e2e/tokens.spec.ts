import { expect, test } from "./engine-test";
import { issueAdvanceLink, issueSigningLink } from "./fixtures";
import {
  DEMO,
  DEMO_PASSWORD,
  expectAccessible,
  expectAccessibleInBothThemes,
  reloadSettled,
  sql,
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

test("an advance section takes one answer until it is returned, then shows why", async ({
  page,
}) => {
  const link = await issueAdvanceLink();
  const open = async () => {
    await page.goto(`/advance/${link.token}`);
    await page.getByLabel("Access code").fill(link.code);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: link.title })).toBeVisible();
  };
  await open();
  const equipment = () =>
    page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "1. Equipment" }) });
  await equipment().getByLabel("Your answer").fill("Two chain hoists.");
  await equipment().getByRole("button", { name: "Send answer" }).click();
  await expect(
    equipment().getByText("Answer sent. The organization reviews it next."),
  ).toBeVisible();

  // A second answer while the first waits for review is refused (migration 2604).
  const [section] = await sql<{ id: string }>(
    `select s.id from app.advance_sections s join app.advance_packets p on p.id = s.advance_packet_id
      where p.title = $1 and s.position = 1`,
    [link.title],
  );
  const [again] = await sql<{ refusal: string | null; reason: string | null }>(
    `select refusal, reason from api_public.submit_advance($1, $2, $3, 'Three chain hoists.')`,
    [link.token, link.code, section?.id],
  );
  expect(again).toEqual({ refusal: "REFUSE", reason: "advance_answer_pending" });

  // The organization returns the answer with a reason; the section shows it and takes an answer again.
  await sql(
    `update app.advance_submissions set reviewed_at = now(), reviewed_by = $2, review_outcome = 'Returned',
       return_reason = 'Say how many spansets you bring.'
     where advance_section_id = $1`,
    [section?.id, DEMO.owner],
    DEMO.owner,
  );
  await open();
  await expect(page.getByText("2 sections left")).toBeVisible();
  await expect(
    equipment().getByText(
      "The organization returned this answer: Say how many spansets you bring.",
    ),
  ).toBeVisible();
  await expectAccessible(page);
  await equipment().getByLabel("Your answer").fill("Two chain hoists and four spansets.");
  await equipment().getByRole("button", { name: "Send answer" }).click();
  await expect(
    equipment().getByText("Answer sent. The organization reviews it next."),
  ).toBeVisible();
});
