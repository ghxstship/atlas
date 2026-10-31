import { expect as baseExpect, test } from "./engine-test";
import { PEOPLE, suffix } from "./role-fixtures";
import { DEMO, expectAccessible, signIn, sql } from "./support";

/**
 * A127 (Section 11.10 rule 5, S11.10-06): Gateway Home's For Your Information list beside Needs You. The vendor clears
 * an update with E (Done) and snoozes the next with H, from the keyboard, without opening either; each leaves the
 * list at once and the database records it (archived, or snoozed for a day).
 */
test.use({ reducedMotion: "reduce" });
const expect = baseExpect.configure({ timeout: 20_000 });

test("A127: Done (E) and Snooze (H) on For Your Information, from the keyboard", async ({
  page,
}) => {
  const tag = suffix();
  // Two invoice updates for the vendor from the demo org they work with (1131), newest last.
  const notify = async (kind: string, title: string) =>
    (
      await sql<{ id: string }>(
        `select private.notify($1, $2, $3, null, null, null,
           jsonb_build_object('title', $4::text, 'orgName', 'Demo Productions', 'gatewayPath', '/money/invoices')) as id`,
        [DEMO.org, PEOPLE.vendorContact, kind, title],
      )
    )[0]?.id as string;
  const older = await notify("invoice.scheduled", `DSS-F-${tag}-1`);
  const newer = await notify("invoice.paid", `DSS-F-${tag}-2`);

  await signIn(page, "vendor@example.com", "/home");
  const list = page.getByRole("list", { name: "For your information" });
  const paid = list
    .getByRole("listitem")
    .filter({ hasText: `Demo Productions paid invoice DSS-F-${tag}-2` });
  const scheduled = list
    .getByRole("listitem")
    .filter({ hasText: `Demo Productions scheduled a payment for invoice DSS-F-${tag}-1` });
  await expect(paid).toBeVisible();
  await expect(scheduled).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await expectAccessible(page);

  // E: Done, from the keyboard; the next item takes the focus.
  await list.getByRole("listitem").first().focus();
  await expect(paid).toBeFocused();
  await page.keyboard.press("e");
  await expect(paid).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (
          await sql<{ archived: boolean }>(
            "select archived_at is not null as archived from app.notifications where id = $1",
            [newer],
          )
        )[0]?.archived,
    )
    .toBe(true);

  // H: Snooze for a day.
  await expect(scheduled).toBeFocused();
  await page.keyboard.press("h");
  await expect(scheduled).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (
          await sql<{ n: string }>(
            `select count(*)::text as n from app.inbox_snoozes
        where notification_id = $1 and deleted_at is null and snoozed_until > now() + interval '23 hours'`,
            [older],
          )
        )[0]?.n,
    )
    .toBe("1");

  // Both stay gone after a reload.
  await page.reload();
  await expect(page.getByText(`DSS-F-${tag}`, { exact: false })).toHaveCount(0);
});
