import { expect as baseExpect, test } from "./engine-test";
import { DEMO, expectAccessible, signIn, sql, uniqueId } from "./support";

// Each save is a server action that renders the page again; a dev server compiles it on first use.
const expect = baseExpect.configure({ timeout: 20_000 });

/**
 * Consent for sensitive data in Gateway (ADR 0164): the accessibility fields stay off Settings, Work Details until the person
 * agrees, and withdrawing clears them; someone else's attestation about the person shows there, and they remove it; a supplier
 * diversity certification needs its own step, and withdrawing removes it and its shares; the company never reads the values.
 */

test("Work Details: agree, save, withdraw, and remove what someone else entered", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const guest = `Consent Guest ${uniqueId()}`;
  await sql("select app.withdraw_sensitive_consent('Accessibility')", [], DEMO.crew);
  try {
    await signIn(page, "crew@example.com", "/settings/work-details");
    await expect(page.getByRole("form", { name: "Accessibility needs" })).toHaveCount(0);
    await page.getByRole("button", { name: "Add accessibility details" }).click();
    const step = page.getByRole("dialog", { name: "Before you add accessibility details" });
    for (const heading of ["What we collect", "Why", "Who sees it", "How to withdraw"]) {
      await expect(step.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }
    await expectAccessible(page);
    await step.getByRole("button", { name: "I agree" }).click();
    await expect(step).toBeHidden();

    const needs = page.getByRole("form", { name: "Accessibility needs" });
    await needs.getByLabel("Accessibility notes").fill("Near an exit");
    await needs.getByRole("button", { name: "Save accessibility needs" }).click();
    await expect(needs.getByRole("status")).toHaveText("Saved.");

    await page
      .getByRole("button", { name: "Withdraw consent and delete accessibility details" })
      .click();
    const confirm = page.getByRole("dialog", { name: "Withdraw your consent?" });
    await confirm.getByRole("button", { name: "Withdraw and delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByRole("button", { name: "Add accessibility details" })).toBeVisible();
    const [row] = await sql<{ notes: string | null }>(
      "select accessibility_notes as notes from app.person_work_details where person_id = $1 and deleted_at is null",
      [DEMO.crew],
    );
    expect(row?.notes ?? null).toBeNull();

    // A producer lists the crew member's needs as a guest, with their email; the person sees it and removes it.
    const [entry] = await sql<{ id: string }>(
      `insert into app.guest_list_entries (project_id, guest_name, entry_state)
       select p.id, $1, 'Requested' from app.projects p where p.org_id = $2 and p.deleted_at is null
       order by p.created_at limit 1 returning id`,
      [guest, DEMO.org],
    );
    await sql(
      `select app.set_guest_care_needs($1, '{Vegan}', null, null, '{}', null, 'crew@example.com', true, true, '2026-11-06', 'en-US', 'Atlas')`,
      [entry?.id],
      DEMO.owner,
    );
    await page.reload();
    const about = page.getByRole("region", { name: "Entered for you by someone else" });
    await expect(about).toContainText(guest);
    await about.getByRole("button", { name: "Remove Dietary and allergies" }).click();
    await expect(about).toHaveCount(0);
    await expectAccessible(page);
    const [left] = await sql<{ n: number }>(
      "select count(*)::int as n from app.guest_care_needs where guest_list_entry_id = $1",
      [entry?.id],
    );
    expect(left?.n).toBe(0);
  } finally {
    await sql("update app.guest_list_entries set deleted_at = now() where guest_name = $1", [
      guest,
    ]);
  }
});

test("Supplier diversity: the form needs its own step, and withdrawing removes the certification", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const body = `Consent Body ${uniqueId()}`;
  await sql("select app.withdraw_sensitive_consent('Supplier Diversity')", [], DEMO.crew);
  await signIn(page, "crew@example.com", "/profile");
  const region = page.getByRole("region", { name: "Supplier diversity" });
  await expect(region.getByRole("form", { name: "Add certification" })).toHaveCount(0);
  await region.getByRole("button", { name: "Add a certification" }).click();
  const step = page.getByRole("dialog", {
    name: "Before you add a supplier diversity certification",
  });
  await expectAccessible(page);
  await step.getByRole("button", { name: "I agree" }).click();
  await expect(step).toBeHidden();
  const add = region.getByRole("form", { name: "Add certification" });
  await add.getByLabel("Certification").selectOption({ label: "Women-owned business" });
  await add.getByLabel("Certified by").fill(body);
  await add.getByRole("button", { name: "Add certification" }).click();
  await expect(region.getByText(body)).toBeVisible();

  await region.getByRole("button", { name: "Withdraw consent and remove certifications" }).click();
  const confirm = page.getByRole("dialog", { name: "Withdraw your consent?" });
  await confirm.getByRole("button", { name: "Withdraw and delete" }).click();
  await expect(confirm).toBeHidden();
  await expect(region.getByText(body)).toHaveCount(0);
  await expect(region.getByRole("button", { name: "Add a certification" })).toBeVisible();
  const [row] = await sql<{ n: number }>(
    "select count(*)::int as n from app.supplier_diversity_certifications where certifying_body = $1",
    [body],
  );
  expect(row?.n).toBe(0);
});
