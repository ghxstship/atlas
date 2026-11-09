import { expect as baseExpect, test } from "./engine-test";
import { DEMO, expectAccessible, reloadSettled, signIn, sql } from "./support";

/**
 * Gateway calendar feeds (A84, RRR-129, finding A65-018, Section 4.5.8 Work "with a calendar
 * feed"): from Upcoming the crew person opens Settings, Calendar Feeds, adds a feed of their own
 * work across orgs, subscribes with its link (a VCALENDAR on Gateway's host), gets a new link (the
 * old one answers 404) and revokes it (the new one answers 404). Every feed the journey leaves is
 * revoked afterwards. B7 (ADR 0146): the feed is named and shows cues too; the calendar takes its
 * name, and Edit renames it without changing the link.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 30_000 });

test.afterEach(async () => {
  await sql(
    `update app.person_calendar_feeds set revoked_at = now() where person_id = $1 and revoked_at is null`,
    [DEMO.crew],
    DEMO.crew,
  );
});

test("calendar feeds: subscribe to my work, get a new link and revoke", async ({ page }) => {
  await signIn(page, "crew@example.com", "/work/upcoming");
  await page.getByRole("link", { name: "Subscribe in a calendar app" }).click();
  await page.waitForURL("**/settings/calendar-feeds");
  await expect(page.getByText("You have no calendar feeds yet.")).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel("Name").fill("My tour");
  await page.getByRole("checkbox", { name: "Cues" }).check();
  await page.getByRole("button", { name: "Add a feed" }).click();
  const panel = page.getByTestId("calendar-feed-link").last();
  const first = await panel.getByLabel("Subscription link").inputValue();
  expect(first).toMatch(/\/ical\/xcal_[0-9a-f]{64}\.ics$/);
  const live = await page.request.get(first);
  expect(live.status()).toBe(200);
  expect(live.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
  const body = await live.text();
  expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  expect(body).toContain("X-WR-CALNAME:My tour");
  await expect(page.getByRole("list", { name: "Your calendar feeds" })).toBeVisible();
  await expect(page.getByText("Shows Shifts, Meetings, Milestones, Deadlines, Cues")).toBeVisible();
  await expectAccessible(page);

  // The link is shown once: after a reload only its last four characters remain.
  await reloadSettled(page);
  await expect(page.getByTestId("calendar-feed-link")).toHaveCount(0);
  const hint = first.slice(-8, -4);
  await expect(page.getByText(`Link ending in ${hint}`)).toBeVisible();
  await page.getByRole("button", { name: `Edit the feed ending in ${hint}` }).click();
  const edit = page.getByRole("dialog");
  await edit.getByLabel("Name").fill("Festival season");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByText("Festival season")).toBeVisible();
  expect(await (await page.request.get(first)).text()).toContain("X-WR-CALNAME:Festival season");
  await page.getByRole("button", { name: `Get a new link for the feed ending in ${hint}` }).click();
  const rotate = page.getByRole("dialog");
  await rotate.getByRole("button", { name: "Get a new link" }).click();
  await expect(rotate).toBeHidden();
  const second = await page
    .getByTestId("calendar-feed-link")
    .last()
    .getByLabel("Subscription link")
    .inputValue();
  expect(second).not.toBe(first);
  expect((await page.request.get(first)).status()).toBe(404);
  expect((await page.request.get(second)).status()).toBe(200);

  await page
    .getByRole("button", { name: `Revoke the feed ending in ${second.slice(-8, -4)}` })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("You have no calendar feeds yet.")).toBeVisible();
  expect((await page.request.get(second)).status()).toBe(404);
});
