import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import { DEMO, sql, uniqueId } from "./support";

/**
 * B10 (RRR-234, G-129, ADR 0149 decision 3): an org opens a registration page with a template's nine questions and a minimum
 * age of 18. A signed-out visitor sees the page and no pool, signs up, fills their work phone first, walks the steps with at
 * most seven visible fields each, confirms 18 or older, shares through the picker and registers. Atlas approves; the Pools
 * page names the person, who hears the decision and sees a Pool-visibility opportunity in Explore.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("a registration page: open it, register, approve, and the person is on the list by name", async ({
  page,
  browser,
}) => {
  const id = uniqueId().slice(-6).toLowerCase();
  const slug = `crew-${id}`;
  const poolName = `Secret Stagehands ${id}`;
  const [pool] = await sql<{ id: string }>(
    `insert into app.talent_pools (org_id, name, pool_kind) values ($1, $2, 'Talent') returning id`,
    [DEMO.org, poolName],
    DEMO.owner,
  );
  const [template] = await sql<{ id: string }>(
    `insert into app.application_question_templates (org_id, name) values ($1, $2) returning id`,
    [DEMO.org, `Crew basics ${id}`],
    DEMO.owner,
  );
  for (let n = 1; n <= 9; n += 1) {
    await sql(
      `insert into app.application_template_questions (application_question_template_id, prompt, sort_order, is_required)
       values ($1, $2, $3, $4)`,
      [template?.id, `Question ${n} about the work`, n, n === 1],
      DEMO.owner,
    );
  }

  const { context: orgContext, page: atlas } = await atlasAs(browser, "owner@example.com");
  await atlas.goto(`/${ORG}/opportunities/registration-pages?create=1`);
  const create = atlas.getByRole("main");
  await create.getByLabel("Title").fill(`Summer Crew ${id}`);
  await create.getByLabel("Address").fill(slug);
  await create.getByLabel("Talent pool").selectOption(pool?.id as string);
  await create.getByLabel("Minimum age").fill("18");
  await create.getByRole("button", { name: "Create page" }).click();
  await atlas.getByRole("link", { name: `Summer Crew ${id}` }).click();
  await atlas.waitForURL(/page=/);
  await atlas.getByRole("combobox", { name: "Question template" }).selectOption(template?.id as string);
  await atlas.getByRole("button", { name: "Apply template" }).click();
  await expect(atlas.getByLabel("Question", { exact: true })).toHaveCount(10);
  await atlas.getByRole("button", { name: "Publish" }).click();
  await expect(atlas.getByText("Open", { exact: true }).first()).toBeVisible();

  // Signed out: the page's copy, never the pool.
  await page.goto(`/join/${ORG}/${slug}`);
  await expect(page.getByRole("heading", { name: `Summer Crew ${id}` })).toBeVisible();
  await expect(page.getByText("You must be 18 or older.")).toBeVisible();
  await expect(page.getByText(poolName)).toHaveCount(0);

  // Sign up, and come back to the page. The page's Sign up link carries next=.
  await page.getByRole("link", { name: "Sign up" }).click();
  await page.waitForURL(/\/auth\/sign-up/);
  const email = `reggie-${id}@example.com`;
  await page.locator("#signup-name").fill(`Reggie Crew ${id}`);
  await page.locator("#signup-email").fill(email);
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.locator("#signup-password").fill("Tidal-Copper-Ladder-4821");
  await page.locator("#signup-terms").check();
  await page.locator("#signup-age").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(new RegExp(`/join/${ORG}/${slug}`), { timeout: 60_000 });

  // Work phone first, seven fields a step.
  const form = page.getByRole("form", { name: "Register" });
  const visible = form.locator("input:visible:not([type=hidden]), textarea:visible");
  await expect(form.getByLabel("Work phone")).toBeVisible();
  expect(await visible.count()).toBeLessThanOrEqual(7);
  await form.getByLabel("Work phone").fill("+13055550142");
  await form.getByLabel("Question 1 about the work").fill("Rigging and load-in.");
  await form.getByRole("button", { name: "Next" }).click();
  await expect(form.getByLabel("Question 6 about the work")).toBeVisible();
  expect(await visible.count()).toBeLessThanOrEqual(7);
  await form.getByRole("button", { name: "Next" }).click();
  await form.getByRole("checkbox", { name: "I am 18 or older" }).check();
  await form.getByRole("combobox", { name: "Share from your profile" }).click();
  await page.getByRole("option", { name: "Skills" }).click();
  await page.keyboard.press("Escape");
  await form.getByRole("button", { name: "Register" }).click();
  await expect(page.getByRole("status")).toContainText("You registered.");
  await expect(page.getByText(poolName)).toHaveCount(0);

  // Atlas approves through the picker, and the Pools page names the person.
  await atlas.goto(`/${ORG}/opportunities/registration-pages`);
  await atlas.getByRole("combobox", { name: "People to decide" }).click();
  await atlas.getByRole("option", { name: new RegExp(`Reggie Crew ${id}`) }).click();
  await atlas.keyboard.press("Escape");
  await atlas.getByRole("button", { name: /Approve 1 person/ }).click();
  await expect(atlas.getByText(`Reggie Crew ${id} was decided.`)).toBeVisible();
  await atlas.goto(`/${ORG}/opportunities/pools?pool=${pool?.id}`);
  await expect(atlas.getByText(`Reggie Crew ${id}`)).toBeVisible();

  // The person hears it, and Explore shows work offered to the pool.
  const title = `Pool Riggers ${id}`;
  await sql(
    `insert into app.opportunities (project_id, role_type, role_code, title, visibility, rate_type, pay_min_minor, pay_max_minor,
       currency_code, starts_on, ends_on, deadline_at, requisition_id)
     select $1, 'Crew', '5000.51.02', $2, 'Pool', 'Day', 85000, 95000, 'USD', '2027-06-04', '2027-06-06', now() + interval '30 days',
       '01920000-0000-7000-8000-000000228001'`,
    [DEMO.project, title],
    DEMO.owner,
  );
  await sql(
    `select private.transition_lifecycle('opportunity', 'app.opportunities', 'opportunity_state', 'app.opportunity_state_transitions',
       'opportunity_id', o.id, 'Draft', 'Published', 'Fixture.') from app.opportunities o where o.title = $1`,
    [title],
    DEMO.owner,
  );
  // The decision reaches them: a notification with the outcome, and the page they registered on says so.
  const [decided] = await sql<{ outcome: string }>(
    `select n.args ->> 'outcome' as outcome from app.notifications n
       join app.people p on p.id = n.recipient_person_id join auth.users u on u.id = p.user_id
      where u.email = $1 and n.kind = 'crew_registration.decided'`,
    [email],
  );
  expect(decided?.outcome).toBe("approved");
  await page.goto(`/join/${ORG}/${slug}`);
  await expect(page.getByText("You are approved.", { exact: false })).toBeVisible();
  await page.goto("/explore");
  await expect(page.getByText(title)).toBeVisible();

  await orgContext.close();
});
