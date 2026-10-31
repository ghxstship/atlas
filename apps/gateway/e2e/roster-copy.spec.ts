import { toDisplayKey } from "@xos/data/gateway-keys";
import { expect as baseExpect, test } from "./engine-test";
import { asPerson, newSignIn, PEOPLE, PROJECT, suffix } from "./role-fixtures";
import { DEMO, signIn, sql } from "./support";

/**
 * B14 (RRR-238; G-252, ADR 0153 D4): a vendor's Account Owner reuses the roster of a past event. The company is engaged
 * by the demo org on two projects; last event's roster holds an open invitation. On this event's Crew tab, Reuse a
 * roster from a past event previews the address to invite again, queues nothing until Add to roster, then adds it as
 * a draft with one invitation; nothing is submitted. The company, its engagements and entries are new on every run and
 * removed afterwards.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 20_000 });

async function count(text: string, params: unknown[]): Promise<number> {
  const [row] = await sql<{ n: number }>(text, params);
  return row?.n ?? 0;
}

const INVITES = `select count(*)::int as n from app.roster_invitations i
  join app.engagement_roster_entries r on r.id = i.roster_entry_id
  where r.engagement_id = $1 and i.email = $2 and i.revoked_at is null and i.deleted_at is null`;

test("roster reuse: preview, then add last event's invitation as a draft", async ({ page }) => {
  const tag = suffix();
  const ownerEmail = `copy-owner-${tag.toLowerCase()}@example.com`;
  const invitee = `copy-crew-${tag.toLowerCase()}@example.com`;
  const owner = await newSignIn(ownerEmail, `Demo Copy Owner ${tag}`);
  const [account] = await asPerson<{ id: string }>(
    owner,
    `select app.create_external_account($1, $2, 'For-Profit') as id`,
    [`Demo Copy Supply ${tag}`, `demo-copy-${tag.toLowerCase()}`],
  );
  const accountId = account?.id as string;
  const [counterparty] = await sql<{ id: string }>(
    `insert into app.counterparties (org_id, organization_id) values ($1, $2) returning id`,
    [DEMO.org, accountId],
    PEOPLE.owner,
  );
  const [other] = await sql<{ id: string }>(
    `select id from app.projects where org_id = $1 and id <> $2 and deleted_at is null order by created_at limit 1`,
    [DEMO.org, PROJECT],
  );
  const engage = async (projectId: string) => {
    const [row] = await sql<{ id: string }>(
      `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
         pay_basis, arrangement, start_date)
       values ($1, $2, $3, 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-06-04')
       returning id`,
      [projectId, owner, counterparty?.id],
      PEOPLE.owner,
    );
    return row?.id as string;
  };
  const past = await engage(other?.id as string);
  const current = await engage(PROJECT);
  try {
    await asPerson(owner, `select app.invite_to_roster($1, $2)`, [past, invitee]);
    await signIn(page, ownerEmail, "/home");
    await page.context().addCookies([{ name: "xos-acting", value: accountId, url: page.url() }]);
    await page.goto(`/work/engagements/${toDisplayKey("engagement", current)}/crew`);
    const panel = page.locator("section", {
      has: page.getByRole("heading", { name: "Reuse a roster from a past event" }),
    });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Preview" }).click();
    await expect(panel.getByText("1 address invited again")).toBeVisible();
    await expect(panel.getByText(invitee)).toBeVisible();
    expect(await count(INVITES, [current, invitee])).toBe(0);
    await panel.getByRole("button", { name: "Add to roster" }).click();
    await expect(
      page.getByText("Added as drafts. Review them and submit the roster."),
    ).toBeVisible();
    expect(await count(INVITES, [current, invitee])).toBe(1);
    expect(
      await count(
        `select count(*)::int as n from app.engagement_roster_entries where engagement_id = $1 and entry_state <> 'Draft'
           and not is_self and deleted_at is null`,
        [current],
      ),
    ).toBe(0);
  } finally {
    for (const id of [past, current]) {
      await sql(
        `update app.engagement_roster_entries set deleted_at = now() where engagement_id = $1 and deleted_at is null`,
        [id],
      );
      await sql("update app.engagements set deleted_at = now() where id = $1", [id]);
    }
  }
});
