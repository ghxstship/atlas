import pg from "pg";
import { expect as baseExpect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * B16 (RRR-240, ADR 0155): the member blocklist refuses an invitation and counts matching members; a started
 * subscription pause shows its banner to every member, refuses an edit and offers the Owner Resume now; a change a
 * connected app proposed waits in Connected apps, Confirm writes the record and marks it Applied, and Reject leaves the
 * record alone. The pause and the proposals are seeded as postgres against the local stack only (E2E_DATABASE_URL),
 * as the Stripe webhook and the hosted MCP endpoint would record them.
 */

const databaseUrl =
  process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(databaseUrl)) {
  throw new Error("The B16 journey touches only a local Supabase stack.");
}

async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

const expect = baseExpect.configure({ timeout: 30_000 });

test("the blocklist refuses an invitation to a blocked domain and counts matching members", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const id = uniqueId();
  const slug = `block-${id}`;
  await signUp(page, { name: "Bea Blocker", email: testEmail("blocker", id) });
  await createOrganization(page, { name: `Block Co ${id}`, slug });
  await page.goto(`/${slug}/settings/members`);
  const panel = page.getByTestId("blocklist-panel");
  await expect(panel.getByRole("heading", { name: "Blocklist" })).toBeVisible();
  const form = panel.getByTestId("blocklist-add-form");
  await form.getByLabel("Address or domain").fill(`Blocked-${id}.test`);
  await form.getByRole("button", { name: "Add to blocklist" }).click();
  await expect(
    form.getByText(/^Added\. Revoked 0 invitations and declined 0 requests to join\.$/),
  ).toBeVisible();
  await expect(panel.getByTestId("blocklist-entry")).toContainText(`blocked-${id}.test`);
  await expect(panel.getByTestId("blocklist-matching")).toHaveText("No current member matches");
  await expectAccessible(page);

  await page.getByLabel("Email", { exact: true }).fill(`crew@sub.blocked-${id}.test`);
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(
    page.getByText(
      "This email address or its domain is on the organization's blocklist. Remove it in Settings, Members, first.",
    ),
  ).toBeVisible();
});

test("a started pause shows its banner, refuses an edit and offers the Owner Resume now", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const id = uniqueId();
  const slug = `pause-${id}`;
  await signUp(page, { name: "Paz Pauser", email: testEmail("pauser", id) });
  await createOrganization(page, { name: `Pause Co ${id}`, slug });
  // The org pays monthly through Stripe; the Owner paused a month ago for two months.
  await sql(
    `select app.sync_subscription_from_stripe(o.id, $2, $3, 'core', 'Monthly', 'active', now() + interval '20 days', false)
       from app.organizations o where o.slug = $1`,
    [slug, `cus_Pause${id}`, `sub_Pause${id}`],
  );
  await sql(
    `insert into app.subscription_pauses (stripe_subscription_link_id, source, starts_at, resumes_at, requested_by)
     select l.id, 'Owner', now() - interval '1 day', private.pause_resume_at(now() - interval '1 day', 2), m.person_id
     from app.stripe_subscription_links l join app.organizations o on o.id = l.org_id
     join app.memberships m on m.org_id = o.id
     where o.slug = $1 limit 1`,
    [slug],
  );
  await page.goto(`/${slug}/home`);
  const banner = page.getByTestId("paused-banner");
  await expect(banner).toContainText("This organization is paused until");
  await expect(banner).toContainText(
    "Everything stays readable and exportable; changes resume when it does.",
  );
  await expect(banner.getByRole("link", { name: "Resume in Billing and plan" })).toBeVisible();
  await expectAccessible(page);

  await page.goto(`/${slug}/settings/members`);
  const form = page.getByTestId("blocklist-add-form");
  await form.getByLabel("Address or domain").fill(`late-${id}.test`);
  await form.getByRole("button", { name: "Add to blocklist" }).click();
  await expect(
    form.getByText("This organization is read-only, so the blocklist cannot change now."),
  ).toBeVisible();

  await page.goto(`/${slug}/settings/billing-and-plan`);
  const pause = page.getByTestId("pause-panel");
  await expect(pause.getByTestId("pause-status")).toContainText("Paused until");
  await expect(pause.getByRole("button", { name: "Resume now" })).toBeVisible();
  await expect(
    pause.getByText("Resuming starts a new billing period today and charges it now."),
  ).toBeVisible();
});

test("a change a connected app proposed is confirmed into the record, and another is rejected", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const id = uniqueId();
  const slug = `agent-${id}`;
  await signUp(page, { name: "Ada Agent", email: testEmail("agent", id) });
  await createOrganization(page, { name: `Agent Co ${id}`, slug });
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill("AGT");
  await dialog.getByLabel("Project name").fill("Spring Tour");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/AGT/overview`);

  // A Claude connector of the org proposed two renames for the Owner, as app.propose_agent_change records them.
  await sql(
    `with o as (select id from app.organizations where slug = $1),
          p as (select m.person_id from app.memberships m join o on o.id = m.org_id limit 1),
          prj as (select pr.id from app.projects pr join o on o.id = pr.org_id where pr.project_key = 'AGT'),
          a as (insert into app.oauth_apps (org_id, name, redirect_uri)
                select o.id, 'Claude', 'https://claude.ai/api/mcp/auth_callback' from o returning id, org_id),
          c as (insert into app.mcp_connectors (oauth_app_id, client_kind, default_scopes)
                select a.id, 'Claude', array['projects'] from a returning oauth_app_id),
          g as (insert into app.oauth_grants (oauth_app_id, person_id, scopes)
                select a.id, p.person_id,
                       (select array_agg(distinct cap.module_code) from app.capabilities cap
                        where not private.oauth_scope_restricted(cap.module_code))
                from a, p returning id)
     select a.id as app, p.person_id as person, prj.id as project, (select count(*) from c) + (select count(*) from g) as made
     from a, p, prj`,
    [slug],
  ).then(async ([row]) => {
    for (const name of ["Encore Tour", "Wrong Tour"]) {
      await sql(
        `with r as (insert into app.ai_requests (org_id, person_id, feature, model, outcome, completed_at, oauth_app_id)
                    select a.org_id, $2, 'assistant', 'external-agent', 'Answered', now(), a.id from app.oauth_apps a where a.id = $1
                    returning id),
              s as (insert into app.ai_suggestions (request_id, operation_id, target_id, summary, operation_request)
                    select r.id, 'projects.update', $3, $4, jsonb_build_object('path', jsonb_build_object('id', $3::text), 'if_match', '*')
                    from r returning id)
         insert into app.ai_suggestion_fields (suggestion_id, field_path, proposed_value, position)
         select s.id, 'name', to_jsonb($5::text), 0 from s`,
        [row?.["app"], row?.["person"], row?.["project"], `Rename the tour to ${name}.`, name],
      );
    }
  });

  await page.goto(`/${slug}/me/connected-apps`);
  const panel = page.getByTestId("agent-changes-panel");
  await expect(
    panel.getByRole("heading", { name: "Changes your connected apps proposed" }),
  ).toBeVisible();
  const proposals = panel.getByTestId("agent-proposal");
  await expect(proposals).toHaveCount(2);
  await expectAccessible(page);
  const encore = proposals.filter({ hasText: "Rename the tour to Encore Tour." });
  await expect(encore).toContainText("From Claude");
  await encore.getByRole("button", { name: "Confirm" }).click();
  await expect(panel.getByText("Done. The change was made.")).toBeVisible();
  const wrong = panel
    .getByTestId("agent-proposal")
    .filter({ hasText: "Rename the tour to Wrong Tour." });
  await wrong.getByRole("button", { name: "Reject" }).click();
  await expect(panel.getByText("Rejected. Nothing changed.")).toBeVisible();

  const states = await sql<{ summary: string; suggestion_state: string; applied: boolean }>(
    `select s.summary, s.suggestion_state::text, s.applied_id = s.target_id as applied
       from app.ai_suggestions s join app.organizations o on o.id = s.org_id where o.slug = $1 order by s.summary`,
    [slug],
  );
  expect(states).toEqual([
    { summary: "Rename the tour to Encore Tour.", suggestion_state: "Applied", applied: true },
    { summary: "Rename the tour to Wrong Tour.", suggestion_state: "Rejected", applied: null },
  ]);
  await page.goto(`/${slug}/p/AGT/overview`);
  await expect(page.getByText("Encore Tour").first()).toBeVisible();
});
