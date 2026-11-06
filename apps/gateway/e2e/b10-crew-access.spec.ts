import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import { DEMO, sql } from "./support";

/**
 * B10 (RRR-234, G-125, ADR 0149 decision 2): a crew access link, end to end. A crew lead issues a link from the project Crew
 * tab and the one view of the link and code stays until they close it. A signed-out browser sees no org before the code;
 * wrong codes are refused and the right one shows the shift in its own time zone, with the venue as text. Accepting shows
 * in Atlas, a reload needs no code, Forget this code asks again, and revoking in Atlas closes the page.
 * The shift is a Published one on the demo project for the demo Field lead's membership, two days out.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const WORKER_EMAIL = "field@example.com";

async function publishedShift(): Promise<{ id: string; membership: string; person: string }> {
  const [member] = await sql<{ id: string; person: string; name: string }>(
    `select m.id, m.person_id as person, p.full_name as name from app.memberships m
     join app.people p on p.id = m.person_id
     join auth.users u on u.id = p.user_id
     where m.org_id = $1 and lower(u.email) = $2 and m.deleted_at is null limit 1`,
    [DEMO.org, WORKER_EMAIL],
  );
  const [shift] = await sql<{ id: string }>(
    `insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
     values ($1, $2, '5000.51.02', date_trunc('hour', now()) + interval '2 days', date_trunc('hour', now()) + interval '2 days 8 hours', 'America/Los_Angeles')
     returning id`,
    [DEMO.project, member?.id],
    DEMO.owner,
  );
  await sql(`select app.publish_shifts(array[$1]::uuid[])`, [shift?.id], DEMO.owner);
  return {
    id: shift?.id as string,
    membership: member?.id as string,
    person: member?.person as string,
  };
}

test("a crew access link: issue, open with a code, accept, forget, revoke", async ({
  page,
  browser,
}) => {
  const shift = await publishedShift();
  const { context: lead, page: atlas } = await atlasAs(browser, "owner@example.com");

  await atlas.goto(`/${ORG}/p/NWS/crew`);
  await atlas.getByRole("link", { name: "Crew access links" }).click();
  await atlas.waitForURL(/\/crew\/access-links\?project=/);
  await atlas.getByRole("link", { name: "Issue links" }).click();
  await atlas.waitForURL(/issue=1/);

  // The workers load for the project chosen; the picker offers the Field lead.
  const form = atlas.getByRole("form", { name: "Issue links" });
  await form.getByRole("combobox", { name: "Workers" }).click();
  await atlas.getByRole("option").first().click();
  await atlas.keyboard.press("Escape");
  await form.getByLabel("Valid for").selectOption("7");
  await form.getByRole("button", { name: "Issue links" }).click();

  // The one view of the link and code, with a QR, with nothing refreshing it away.
  const result = atlas.getByRole("region", { name: /links? issued/ });
  await expect(result).toBeVisible();
  await expect(atlas.getByText(/not shown again/)).toBeVisible();
  const cardText = await result.innerText();
  const token = /\/shifts\/(xcrw_[0-9a-f]{64})/.exec(cardText)?.[1] as string;
  const code = /\b(\d{6})\b/.exec(cardText)?.[1] as string;
  expect(token).toBeTruthy();
  expect(code).toBeTruthy();
  await expect(result.getByRole("img", { name: /QR code/ })).toBeVisible();
  await atlas.waitForTimeout(1_500);
  await expect(result).toBeVisible();
  await result.getByRole("button", { name: "Close", exact: true }).click();
  await result.getByRole("button", { name: "Close and refresh" }).click();
  await atlas.waitForURL((url) => !url.search.includes("issue=1"));

  // A signed-out browser: neutral until the code.
  const outside = await browser.newContext({ reducedMotion: "reduce" });
  const worker = await outside.newPage();
  await worker.goto(`/shifts/${token}`);
  await expect(worker.getByRole("heading", { name: "My shifts" })).toBeVisible();
  await expect(worker.getByText("Demo Productions")).toHaveCount(0);

  const form2 = worker.getByRole("form", { name: "Open your shifts" });
  for (let i = 0; i < 4; i += 1) {
    await form2.getByLabel("Access code").fill("000000");
    await form2.getByRole("button", { name: "Open" }).click();
    await expect(worker.getByText("That code does not match.")).toBeVisible();
  }
  await form2.getByLabel("Access code").fill(code);
  await form2.getByRole("button", { name: "Open" }).click();

  // The shift, in its own zone, with the venue as text.
  const row = worker
    .getByRole("listitem")
    .filter({ hasText: /PST|PDT/ })
    .first();
  await expect(row).toBeVisible();
  await expect(row.getByText("Published")).toBeVisible();
  await expect(worker.getByRole("link", { name: /map/i })).toHaveCount(0);
  await row.getByRole("button", { name: "Accept shift" }).click();
  await expect(worker.getByRole("status")).toContainText("Shift accepted");
  await expect(row.getByText("Accepted")).toBeVisible();
  await expect(async () => {
    const [state] = await sql<{ shift_state: string }>(
      `select shift_state from app.shifts where id = $1`,
      [shift.id],
    );
    expect(state?.shift_state).toBe("Accepted");
  }).toPass();

  // Atlas sees it.
  await atlas.goto(`/${ORG}/p/NWS/crew?view=list`);
  await expect(atlas.getByText("Accepted").first()).toBeVisible();

  // A reload needs no code; forgetting asks again.
  await worker.reload();
  await expect(worker.getByRole("button", { name: "Forget this code" })).toBeVisible();
  await worker.getByRole("button", { name: "Forget this code" }).click();
  await expect(worker.getByRole("form", { name: "Open your shifts" })).toBeVisible();
  await worker.getByLabel("Access code").fill(code);
  await worker.getByRole("button", { name: "Open" }).click();
  await expect(worker.getByRole("button", { name: "Forget this code" })).toBeVisible();

  // Revoking closes the page.
  await atlas.goto(`/${ORG}/crew/access-links?view=table`);
  await atlas.getByRole("button", { name: "Revoke" }).first().click();
  await expect(atlas.getByText("Revoked").first()).toBeVisible();
  await worker.reload();
  await expect(worker.getByText("This link no longer works.")).toBeVisible();

  await lead.close();
  await outside.close();
});
