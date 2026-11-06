import { cognitiveLoadProblems } from "./a11y/checks";
import { atlasAs, ORG } from "./atlas";
import { expect as baseExpect, settle, test } from "./engine-test";
import { asPerson, PEOPLE, PROJECT, suffix } from "./role-fixtures";
import { DEMO, sql, uniqueId } from "./support";

/**
 * B2 public forms (RRR-226, ADR 0141; gap G-293): a form link from its code through windows of at most seven fields, a
 * conditional field moving between windows as an earlier answer changes, answers surviving Back and Next, a too-fast
 * submit refused, the honeypot out of sight, and a response that becomes a record only when Atlas approves it.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const field = (key: string, label: string, extra: Record<string, unknown> = {}) => ({
  key,
  label,
  kind: "text",
  ...extra,
});

test("a respondent fills a multi-window form and Atlas approves it into a record", async ({
  page,
  browser,
}) => {
  const mark = suffix();
  const id = uniqueId();
  const fields = [
    field("company", "Company"),
    field("has_power", "Needs power", { kind: "yes_no" }),
    field("power_kind", "Power kind", { show_if: { key: "has_power", equals: true } }),
    field("load", "Load in"),
    field("dock", "Dock"),
    field("truck", "Truck"),
    field("notes", "Notes"),
  ];
  const [template] = await sql<{ id: string }>(
    `insert into app.form_templates (org_id, name, description, record_kind, record_subtype, fields)
     values ($1::uuid, $2, 'For suppliers.', 'Inspection', 'Safety', $3::jsonb) returning id`,
    [DEMO.org, `Supplier check ${mark}`, JSON.stringify(fields)],
    PEOPLE.owner,
  );
  await asPerson(PEOPLE.owner, `select app.publish_form_template($1::uuid)`, [template?.id]);
  const [link] = await asPerson<{ form_link_id: string; token: string; access_code: string }>(
    PEOPLE.owner,
    `select l.form_link_id, l.token, l.access_code
       from app.create_form_link($1::uuid, now() + interval '30 days', $2::uuid) l`,
    [template?.id, PROJECT],
  );
  const token = link?.token as string;

  await page.goto(`/forms/${token}`);
  await page.getByLabel("Access code").fill(link?.access_code as string);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const form = page.locator("[data-public-form-window]");
  await expect(form).toBeVisible();
  await settle(page);

  // Page 1 holds name, email and five fields; the honeypot is out of sight.
  await expect(page.getByText("Page 1 of 2")).toBeVisible();
  await expect(page.locator('input[name="website"]')).toBeHidden();
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await page.getByLabel("Your name").fill("Rae Respondent");
  await page.getByLabel("Your email").fill(`rae-${id}@example.com`);
  await page.getByLabel("Company", { exact: true }).fill("Harbor Audio");

  // Without power, the conditional field is on neither page, and Truck still fits on the first.
  await expect(page.getByLabel("Truck", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(form).toHaveAttribute("data-public-form-window", "1");
  await expect(page.getByLabel("Power kind")).toHaveCount(0);
  expect(await cognitiveLoadProblems(page)).toEqual([]);

  // Answers survive Back. Answering Yes brings the field in and moves Truck to the next page, within the limit.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByLabel("Company", { exact: true })).toHaveValue("Harbor Audio");
  await page.getByLabel("Needs power").selectOption("yes");
  await expect(page.getByLabel("Power kind")).toBeVisible();
  await expect(page.getByLabel("Truck", { exact: true })).toHaveCount(0);
  await page.getByLabel("Power kind").fill("Three phase");
  expect(await cognitiveLoadProblems(page)).toEqual([]);

  // Turning it off again hides it, and its stale answer does not travel; on again brings it back.
  await page.getByLabel("Needs power").selectOption("no");
  await expect(page.getByLabel("Power kind")).toHaveCount(0);
  await page.getByLabel("Needs power").selectOption("yes");
  await expect(page.getByLabel("Power kind")).toHaveValue("Three phase");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByLabel("Notes", { exact: true }).fill("Dock two.");

  // A submit before the minimum fill time is refused and stores nothing; answers stay.
  await sql(
    `update private.form_link_grants g set issued_at = now() + interval '1 hour' where g.form_link_id = $1::uuid`,
    [link?.form_link_id],
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That was very quick" })).toBeVisible();
  const [none] = await sql<{ n: number }>(
    `select count(*)::int as n from app.form_submissions where form_link_id = $1::uuid`,
    [link?.form_link_id],
  );
  expect(none?.n).toBe(0);
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue("Dock two.");

  await sql(
    `update private.form_link_grants g set issued_at = now() - interval '1 minute' where g.form_link_id = $1::uuid`,
    [link?.form_link_id],
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("[data-public-form-done]")).toBeVisible();

  // Stored Submitted, with no member and no record until someone approves.
  const [stored] = await sql<{
    id: string;
    submission_state: string;
    submitted_by_membership_id: string | null;
    record_id: string | null;
    power: string;
  }>(
    `select s.id, s.submission_state::text, s.submitted_by_membership_id, s.record_id, s.answers ->> 'power_kind' as power
       from app.form_submissions s where s.form_link_id = $1::uuid`,
    [link?.form_link_id],
  );
  expect(stored).toMatchObject({
    submission_state: "Submitted",
    submitted_by_membership_id: null,
    record_id: null,
    power: "Three phase",
  });

  // Atlas: a public link response shows its badge, and approving makes the project's record.
  const atlas = await atlasAs(browser, "owner@example.com");
  await atlas.page.goto(`/${ORG}/knowledge/forms?section=submissions&peek=${stored?.id}`);
  const peek = atlas.page.getByRole("dialog");
  await expect(peek.getByText("Public link", { exact: true })).toBeVisible();
  await peek.getByRole("button", { name: "Approve", exact: true }).click();
  await expect
    .poll(async () => {
      const [row] = await sql<{ record_id: string | null }>(
        `select record_id from app.form_submissions where id = $1::uuid`,
        [stored?.id],
      );
      return row?.record_id ?? null;
    })
    .not.toBeNull();
  const [record] = await sql<{ record_kind: string; project_id: string }>(
    `select r.record_kind::text, r.project_id from app.records r
       join app.form_submissions s on s.record_id = r.id where s.id = $1::uuid`,
    [stored?.id],
  );
  expect(record).toEqual({ record_kind: "Inspection", project_id: PROJECT });
  await atlas.context.close();
});

test("a public form address asks for a code and answers no-store", async ({ page }) => {
  const token = `xfrm_${"0".repeat(64)}`;
  await page.goto(`/forms/${token}`);
  await expect(page.getByLabel("Access code")).toBeVisible();
  const post = await page.request.post(`/forms/${token}/open`, {
    form: { accessCode: "000000" },
    maxRedirects: 0,
  });
  expect(post.status()).toBe(303);
  expect(post.headers()["cache-control"]).toContain("no-store");
  expect(post.headers()["location"]).toContain("reason=form_link_invalid");
  const get = await page.request.get(`/forms/${token}/open`, { maxRedirects: 0 });
  expect(get.status()).toBe(303);
  expect((await page.request.get("/forms/nope")).status()).toBe(404);
});
