import { expect as baseExpect, test } from "./engine-test";
import { DEMO, expectAccessible, signIn, sql, uniqueId } from "./support";

// Each save is a server action that renders the page again; a dev server compiles it on first use.
const expect = baseExpect.configure({ timeout: 20_000 });

/**
 * Consent for sensitive data in Gateway (ADR 0164): the accessibility fields stay off Settings, Work Details until the person
 * agrees, and withdrawing clears them; someone else's attestation about the person shows there, and they remove it, or say a
 * guest list entry an email matched is someone else; a supplier
 * diversity certification needs its own step, and withdrawing removes it and its shares; the company never reads the values.
 */

test("Work Details: agree, save, withdraw, remove what someone else entered, and say a guest is someone else", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const guest = `Consent Guest ${uniqueId()}`;
  const other = `Someone Else ${uniqueId()}`;
  // A removal stops whoever entered it entering it for the crew member again in that organization. An earlier run's removal
  // is this journey's own fixture, so it goes, and the producer can list the crew member again.
  const journeyEntries =
    "select id from app.guest_list_entries where guest_name like 'Consent Guest %' or guest_name like 'Someone Else %'";
  await sql(
    `delete from app.sensitive_field_records where guest_list_entry_id in (${journeyEntries})`,
  );
  await sql(
    `delete from app.sensitive_data_consents where guest_list_entry_id in (${journeyEntries})`,
  );
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

    // A producer lists a guest with the crew member's email by mistake; the crew member says the guest is someone else, and
    // the guest's needs stay with the list.
    const listGuest = async (name: string, allergies: string | null) => {
      const [entry] = await sql<{ id: string }>(
        `insert into app.guest_list_entries (project_id, guest_name, entry_state)
         select p.id, $1, 'Requested' from app.projects p where p.org_id = $2 and p.deleted_at is null
         order by p.created_at limit 1 returning id`,
        [name, DEMO.org],
      );
      await sql(
        `select app.set_guest_care_needs($1, '{Vegan}', $2, null, '{}', null, 'crew@example.com', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas')`,
        [entry?.id, allergies],
        DEMO.owner,
      );
      return entry?.id;
    };
    const wrong = await listGuest(other, "Shellfish");
    await page.reload();
    const about = page.getByRole("region", { name: "Entered for you by someone else" });
    await expect(about).toContainText(other);
    await about.getByRole("button", { name: `This is not me: ${other}` }).click();
    await expect(about).toHaveCount(0);
    await expectAccessible(page);
    const [kept] = await sql<{ allergies: string | null; email: string | null }>(
      "select allergies, guest_email as email from app.guest_care_needs where guest_list_entry_id = $1",
      [wrong],
    );
    expect(kept).toEqual({ allergies: "Shellfish", email: null });

    // A producer lists the crew member's needs as a guest, with their email; the person sees it and removes it.
    const entry = await listGuest(guest, null);
    await page.reload();
    await expect(about).toContainText(guest);
    await about.getByRole("button", { name: "Remove Dietary and allergies" }).click();
    await expect(about).toHaveCount(0);
    await expectAccessible(page);
    const [left] = await sql<{ n: number }>(
      "select count(*)::int as n from app.guest_care_needs where guest_list_entry_id = $1",
      [entry],
    );
    expect(left?.n).toBe(0);
  } finally {
    await sql("update app.guest_list_entries set deleted_at = now() where guest_name in ($1, $2)", [
      guest,
      other,
    ]);
  }
});

test("A value from before consent: the person sees it, is told it waits, and agreeing keeps it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const person = DEMO.vendorContact;
  const backlog = async () => {
    // Written as a migration would: no signed-in person, so no consent is recorded.
    await sql(
      `insert into app.person_work_details (person_id, allergies)
       select $1, 'Sesame' where not exists (select 1 from app.person_work_details w where w.person_id = $1 and w.deleted_at is null)`,
      [person],
    );
    await sql(
      "update app.person_work_details set allergies = 'Sesame' where person_id = $1 and deleted_at is null",
      [person],
    );
  };
  await sql("select app.withdraw_sensitive_consent('Dietary and Allergies')", [], person);
  await backlog();
  try {
    await signIn(page, "vendor@example.com", "/settings/work-details");
    await expect(page.getByRole("form", { name: "Dietary needs" })).toHaveCount(0);
    await expect(page.getByText(/from before we recorded consent/)).toBeVisible();
    await expect(page.getByText("On file: Sesame", { exact: true })).toBeVisible();
    await expectAccessible(page);

    await page.getByRole("button", { name: "Keep them", exact: true }).click();
    const step = page.getByRole("dialog", { name: "Before you add dietary and allergy details" });
    await step.getByRole("button", { name: "I agree" }).click();
    await expect(step).toBeHidden();
    const needs = page.getByRole("form", { name: "Dietary needs" });
    await expect(needs.getByLabel("Allergies")).toHaveValue("Sesame");
    const [record] = await sql<{ standing: boolean; waiting: boolean }>(
      `select consent_id is not null as standing, awaiting_since is not null as waiting
         from app.sensitive_field_records where person_id = $1 and field_code = 'allergies'`,
      [person],
    );
    expect(record).toEqual({ standing: true, waiting: false });
  } finally {
    await sql("select app.withdraw_sensitive_consent('Dietary and Allergies')", [], person);
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
