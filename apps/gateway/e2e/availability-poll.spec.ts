import { expect as baseExpect, test } from "./engine-test";
import { PEOPLE, PROJECT, projectToday, vendorEngagement } from "./role-fixtures";
import { expectAccessible, signIn, sql } from "./support";

/**
 * P8 (RRR-222, parity gap G-124): a freelancer answers an availability poll in Gateway. The demo org's Owner asks a
 * person it engages for their availability on two days; Home updates link to /profile#availability-requests, where
 * the person answers day by day, and the answers land as availability blocks tagged with the poll on the calendar they
 * keep for that org.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("a freelancer answers an availability poll from Gateway", async ({ page }) => {
  await vendorEngagement();
  const today = await projectToday();
  const title = `Strike crew ${Date.now().toString(36)}`;
  const [poll] = await sql<{ id: string }>(
    `select app.send_availability_poll($1, $2, array[($3::date + 10), ($3::date + 11)], array[$4::uuid]) as id`,
    [PROJECT, title, today, PEOPLE.vendorContact],
    PEOPLE.owner,
  );
  const pollId = poll?.id as string;

  await signIn(page, "vendor@example.com", "/home");
  const update = page.getByRole("link", {
    name: new RegExp(`asks for your availability: ${title}`),
  });
  await expect(update.first()).toBeVisible();
  await update.first().click();
  await page.waitForURL(/\/profile#availability-requests/);

  const form = page.getByRole("form", { name: `Answer ${title}` });
  await expect(form).toBeVisible();
  const selects = form.getByRole("combobox");
  await selects.nth(0).selectOption("Available");
  await selects.nth(1).selectOption("Tentative");
  await expectAccessible(page);
  await form.getByRole("button", { name: "Send answers" }).click();
  await expect(form.getByText("Answers saved.")).toBeVisible();

  await expect
    .poll(async () => {
      const rows = await sql<{ n: number }>(
        `select count(*)::int as n from app.availability_blocks
          where availability_poll_id = $1 and deleted_at is null`,
        [pollId],
      );
      return rows[0]?.n;
    })
    .toBe(2);
});
