import { expect as baseExpect, settle, test } from "./engine-test";
import { expectAccessible, sql, uniqueId } from "./support";

/**
 * B8 (RRR-232, gap G-71, ADR 0147 decision 7): a guest stops the emails of the org that sent them. A guest of the
 * demo tenant's NWS project is queued an invitation and the worker's claim issues the row's unsubscribe token; the
 * Gateway page that link opens asks first, and opening it (a GET, as a mail scanner would) changes nothing. Pressing
 * Stop emails adds the address to the org's suppression list once.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(120_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const ORG_ID = "01920000-0000-7000-8000-000000000001";
const OWNER = "01920000-0000-7000-8000-000000000101";

test("the unsubscribe page asks before it stops a guest's emails (B8)", async ({ page }) => {
  const id = uniqueId().slice(-8).toLowerCase();
  const email = `guest.${id}@example.com`;
  const [entry] = await sql<{ id: string }>(
    `insert into app.guest_list_entries (project_id, guest_name, guest_email)
     values ((select id from app.projects where org_id = $1 and project_key = 'NWS'), $2, $3) returning id`,
    [ORG_ID, `Guest ${id}`, email],
    OWNER,
  );
  const [send] = await sql<{ id: string }>(
    `select app.queue_guest_emails((select id from app.projects where org_id = $1 and project_key = 'NWS'),
       array[$2::uuid], 'Invitation') as id`,
    [ORG_ID, entry?.id],
    OWNER,
  );
  const claimed = await sql<{ guest_list_entry_id: string; unsubscribe_token: string }>(
    "select guest_list_entry_id, unsubscribe_token from app.claim_guest_emails(100)",
  );
  const token = claimed.find((c) => c.guest_list_entry_id === entry?.id)?.unsubscribe_token;
  expect(send?.id).toBeTruthy();
  expect(token).toMatch(/^xgue_[0-9a-f]{64}$/);
  const suppressed = async () =>
    (
      await sql<{ n: number }>(
        `select count(*)::int as n from app.suppression_list
          where org_id = $1 and channel = 'Email' and address = $2 and lifted_at is null and deleted_at is null`,
        [ORG_ID, email],
      )
    )[0]?.n ?? 0;

  await page.goto(`/unsubscribe/${token}`);
  await settle(page);
  await expect(page.getByRole("heading", { name: "Stop emails" })).toBeVisible();
  await expectAccessible(page);
  expect(await suppressed()).toBe(0);

  await page.getByRole("button", { name: "Stop emails" }).click();
  await expect(page.getByRole("status")).toContainText("You will not get emails from");
  expect(await suppressed()).toBe(1);
});
