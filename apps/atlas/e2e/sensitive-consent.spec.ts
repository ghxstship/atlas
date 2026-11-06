import pg from "pg";
import { expect as baseExpect, test } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { cognitiveLoadProblems } from "./a11y/checks";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

// Each save is a server action that renders the page again; a dev server compiles it on first use.
const expect = baseExpect.configure({ timeout: 20_000 });

/**
 * Consent for sensitive data in Atlas (ADR 0164).
 *   - A person's own: the fields stay off the page until they read the step and agree; declining leaves everything else
 *     working; agreeing records the wording's version, the language and the surface; withdrawing takes one button and one
 *     confirmation, and the data is gone.
 *   - Someone else's: whoever keeps a guest list confirms two statements before entering a guest's needs, and sees only that
 *     they are on file; the Owner reads them; the door note refuses them.
 */

async function localSql<T extends Record<string, unknown>>(
  text: string,
  args: unknown[] = [],
): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error("This journey reads evidence only on a local Supabase stack.");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(text, args)).rows as T[];
  } finally {
    await client.end();
  }
}

test("a person reads the step, agrees, saves, withdraws, and the data is gone", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const id = uniqueId();
  const slug = `consent-${id}`;
  const email = testEmail("consent", id);
  await signUp(page, { name: "Wren Consent", email });
  await createOrganization(page, { name: `Consent ${id}`, slug });

  await page.goto(`/${slug}/me/work-details`);
  // No field before the step, and nothing else needs it.
  await expect(page.getByRole("form", { name: "Dietary needs" })).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Accessibility needs" })).toHaveCount(0);
  const add = page.getByRole("form", { name: "Add contact" });
  await add.getByLabel("Name").fill("Robin Example");
  await add.getByLabel("Phone", { exact: true }).fill("(305) 555-0142");
  await add.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Robin Example" })).toBeVisible();
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await expectAccessible(page);

  // The step says what, why, who and how to withdraw. Not now changes nothing.
  await page.getByRole("button", { name: "Add dietary details" }).click();
  const step = page.getByRole("dialog", { name: "Before you add dietary and allergy details" });
  for (const heading of ["What we collect", "Why", "Who sees it", "How to withdraw"]) {
    await expect(step.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  await expectAccessible(page);
  await step.getByRole("button", { name: "Not now" }).click();
  await expect(step).toBeHidden();
  await expect(page.getByRole("form", { name: "Dietary needs" })).toHaveCount(0);

  // Agreeing shows the fields and records the evidence.
  await page.getByRole("button", { name: "Add dietary details" }).click();
  await step.getByRole("button", { name: "I agree" }).click();
  await expect(step).toBeHidden();
  const dietary = page.getByRole("form", { name: "Dietary needs" });
  await dietary.getByLabel("Allergies").fill("Peanuts, anaphylaxis");
  await dietary.getByRole("button", { name: "Save dietary needs" }).click();
  await expect(dietary.getByRole("status")).toHaveText("Saved.");
  await expect(page.getByText(/You agreed on .*wording version 2026-11-06/)).toBeVisible();
  const [evidence] = await localSql<{
    notice_version: string;
    locale: string;
    surface: string;
    basis: string;
  }>(
    `select c.notice_version, c.locale, c.surface::text, c.basis::text
       from app.sensitive_data_consents c join app.people p on p.id = c.person_id
       join auth.users u on u.id = p.user_id
      where lower(u.email) = lower($1) and c.category = 'Dietary and Allergies'`,
    [email],
  );
  expect(evidence).toEqual({
    notice_version: "2026-11-06",
    locale: "en-US",
    surface: "Atlas",
    basis: "Own Consent",
  });
  // Consent is specific: accessibility still has its own step.
  await expect(page.getByRole("form", { name: "Accessibility needs" })).toHaveCount(0);

  // Withdrawing is one button and one confirmation.
  await page.getByRole("button", { name: "Withdraw consent and delete dietary details" }).click();
  const confirm = page.getByRole("dialog", { name: "Withdraw your consent?" });
  await confirm.getByRole("button", { name: "Withdraw and delete" }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole("form", { name: "Dietary needs" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add dietary details" })).toBeVisible();
  const [row] = await localSql<{ allergies: string | null; withdrawn: boolean }>(
    `select w.allergies, c.withdrawn_at is not null as withdrawn
       from app.sensitive_data_consents c join app.people p on p.id = c.person_id
       join auth.users u on u.id = p.user_id
       left join app.person_work_details w on w.person_id = p.id
      where lower(u.email) = lower($1)`,
    [email],
  );
  expect(row).toEqual({ allergies: null, withdrawn: true });
  await expect(page.getByRole("region", { name: "Access log" })).not.toContainText("Peanuts");
});

test("whoever keeps a guest list attests, and only the Owner reads the needs back", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const id = uniqueId();
  const guest = `Consent Guest ${id}`;
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/p/NWS/advancing?section=guests`);
  await page.getByRole("button", { name: "Add guest" }).click();
  const add = page.getByRole("dialog", { name: "Add a guest" });

  // The door note has no consent step, and says where this goes.
  await add.getByLabel("Guest name").fill(guest);
  await add.getByLabel("Note for the door").fill("Vegan, nut allergy");
  await add.getByRole("button", { name: "Add guest" }).click();
  await expect(add.getByText(/Leave dietary and access needs out of the note/)).toBeVisible();
  await expect(add.getByLabel("Guest name")).toHaveValue(guest);
  await add.getByLabel("Note for the door").fill("Side stage");
  await add.getByRole("button", { name: "Add guest" }).click();
  await expect(add).toBeHidden();

  // Two statements first, then the needs, every one optional.
  const row = page.getByRole("listitem").filter({ hasText: guest });
  await row.getByRole("button", { name: `Dietary and access needs for ${guest}` }).click();
  const needs = page.getByRole("dialog", { name: `Dietary and access needs for ${guest}` });
  const next = needs.getByRole("button", { name: "Continue" });
  await expect(next).toBeDisabled();
  await needs.getByLabel("I have this person's authority to enter this.").check();
  await expect(next).toBeDisabled();
  await needs.getByLabel("This person has been told what is entered, why and who sees it.").check();
  await next.click();
  // Checked before typing: the check moves focus, and a dialog closes when focus leaves a field for outside it.
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await expectAccessible(page);
  await needs.getByLabel("Allergies").fill("Shellfish");
  await needs.getByRole("button", { name: "Save needs" }).click();
  await expect(needs).toBeHidden();
  await expect(row).toContainText("Needs on file");

  const [attestation] = await localSql<{
    basis: string;
    authority: boolean;
    notice: boolean;
    by: string;
  }>(
    `select c.basis::text, c.authority_confirmed as authority, c.notice_confirmed as notice, p.full_name as by
       from app.sensitive_data_consents c
       join app.guest_list_entries g on g.id = c.guest_list_entry_id
       join app.people p on p.id = c.given_by
      where g.guest_name = $1`,
    [guest],
  );
  expect(attestation).toMatchObject({ basis: "Attested Authority", authority: true, notice: true });

  // The Owner holds the capability, and each read is logged.
  await page.getByRole("button", { name: "Read guest needs" }).click();
  const read = page.getByRole("dialog", { name: "Guest needs on this project" });
  await expect(read).toContainText("Shellfish");
  await read.getByRole("button", { name: "Close" }).click();
  const [audited] = await localSql<{ n: number }>(
    "select count(*)::int as n from app.audit_events e where e.action = 'guest_needs.viewed'",
  );
  expect(audited?.n ?? 0).toBeGreaterThan(0);

  // Removing the needs is one step, and the guest stays.
  await row.getByRole("button", { name: `Dietary and access needs for ${guest}` }).click();
  await needs.getByRole("button", { name: "Remove needs" }).click();
  await expect(needs).toBeHidden();
  await expect(row).not.toContainText("Needs on file");
  await localSql("update app.guest_list_entries set deleted_at = now() where guest_name = $1", [
    guest,
  ]);
});
