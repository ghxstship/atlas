import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * A08 Show journeys (Section 20.2): 15 (run a live run of show with cue progression, here in two
 * browser contexts: the stage manager calls cues and a follower sees them advance), plus work
 * orders with the separated award, punch lists, day sheets and call sheets.
 */

test.use({ reducedMotion: "reduce" });

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
}

async function expectAccessible(page: Page): Promise<void> {
  await settle(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude('span[aria-current="date"]')
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
}

async function newOwnerOrg(page: Page): Promise<string> {
  const id = uniqueId();
  const slug = `shw-${id}`;
  await signUp(page, { name: "Sky Stage", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Show ${id}`, slug });
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill("SHW");
  await dialog.getByLabel("Project name").fill("Summer Headline Weekend");
  await dialog.getByRole("button", { name: "More fields" }).click();
  await dialog.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await dialog.getByLabel("Tier of experience").selectOption({ index: 5 });
  await dialog.getByLabel("First production day").fill("2027-03-12");
  await dialog.getByLabel("Last production day").fill("2027-03-15");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/SHW/overview`);
  return slug;
}

test("journey 15: a live run of show with cue progression seen by a follower", async ({
  page,
  browser,
}) => {
  const slug = await newOwnerOrg(page);
  await page.goto(`/${slug}/show/run-of-show`);
  await expect(page.getByText("No running orders yet.")).toBeVisible();
  await expectAccessible(page);

  await page.goto(`/${slug}/show/run-of-show?create=1`);
  const sheet = page.getByRole("dialog", { name: "New running order" });
  await sheet.getByLabel("Name").fill("Opening Night Running Order");
  await sheet.getByLabel("Show day").fill("2027-03-13");
  await sheet.getByRole("button", { name: "Create running order" }).click();
  await page.waitForURL(/peek=/);
  const runUrl = page.url();

  for (const label of ["House to Half", "Walk-in Music Out", "Headliner On"]) {
    await page.getByLabel("Cue", { exact: true }).fill(label);
    await page.getByRole("button", { name: "Add cue" }).click();
    await expect(
      page.getByRole("list", { name: "Cues of Opening Night Running Order" }),
    ).toContainText(label);
  }
  await expectAccessible(page);

  // A follower opens the same running order in live mode in another session.
  const follower = await browser.newContext({
    storageState: await page.context().storageState(),
    reducedMotion: "reduce",
  });
  const watch = await follower.newPage();
  await watch.goto(`${runUrl}&live=1`);
  await expect(watch.getByRole("status").filter({ hasText: "No cue called yet" })).toBeVisible();

  // The stage manager goes live and calls the cues in order.
  await page.getByRole("button", { name: "Run live" }).click();
  await page.getByRole("button", { name: "Call next cue" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Current cue: House to Half" }),
  ).toBeVisible();
  await expect(
    watch.getByRole("status").filter({ hasText: "Current cue: House to Half" }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Call next cue" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Current cue: Walk-in Music Out" }),
  ).toBeVisible();
  await expect(
    watch.getByRole("status").filter({ hasText: "Current cue: Walk-in Music Out" }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Call next cue" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The show is complete" })).toBeVisible();
  await expectAccessible(page);
  await follower.close();

  // Leaving live mode shows who called each cue.
  await page.getByRole("button", { name: "Leave live mode" }).click();
  await expect(page.getByText(/Called .* by Sky Stage/).first()).toBeVisible();
  for (const view of ["table", "timeline", "list"]) {
    await page.goto(`/${slug}/show/run-of-show?view=${view}`);
    await expect(page.getByText("Opening Night Running Order").first()).toBeVisible();
    await expectAccessible(page);
  }
});

test("work orders: bids, unpriced stays unpriced, and the creator cannot award", async ({
  page,
}) => {
  const slug = await newOwnerOrg(page);
  await page.goto(`/${slug}/work/work-orders`);
  await expect(page.getByText("No work orders yet.")).toBeVisible();
  await expectAccessible(page);
  await page.goto(`/${slug}/work/work-orders?create=1`);
  const sheet = page.getByRole("dialog", { name: "New work order" });
  await sheet.getByLabel("Title").fill("Rig the Main Stage Truss");
  await sheet.getByRole("button", { name: "Create work order" }).click();
  await page.waitForURL(/peek=/);
  await expect(page.getByText("No bids yet.")).toBeVisible();
  await page.getByRole("button", { name: "Move to Open for Bids" }).click();
  await page
    .getByLabel(/Move SHW-WO-1 to Open for Bids/)
    .fill("Bids invited from the rigging pool.");
  await page.getByRole("button", { name: "Move record" }).click();
  await expect(
    page.getByText("You created this work order, so someone else awards it."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Award" })).toHaveCount(0);
  await expectAccessible(page);
  for (const view of ["table", "board", "list"]) {
    await page.goto(`/${slug}/work/work-orders?view=${view}`);
    await expect(page.getByText("Rig the Main Stage Truss").first()).toBeVisible();
    await expectAccessible(page);
  }
});

test("punch lists, day sheets and call sheets", async ({ page }) => {
  const slug = await newOwnerOrg(page);
  await page.goto(`/${slug}/work/punch-lists?create=1`);
  const punch = page.getByRole("dialog", { name: "New punch item" });
  await punch.getByLabel("What must be corrected").fill("the handrail at stair 2 is loose.");
  await punch.getByLabel("Where").fill("Stair 2 landing");
  await punch.getByRole("button", { name: "Raise punch item" }).click();
  await expect(page.getByText("Correct the handrail at stair 2 is loose").first()).toBeVisible();
  await expectAccessible(page);

  await page.goto(`/${slug}/show/day-sheets?create=1`);
  const day = page.getByRole("dialog", { name: "New day sheet" });
  await day.getByLabel("Day").fill("2027-03-13");
  await day.getByRole("button", { name: "Create day sheet" }).click();
  await page.waitForURL(/peek=/);
  await page.getByRole("textbox", { name: "Day sheet" }).fill("Doors 7 pm. Load-out after curfew.");
  await page.getByRole("button", { name: "Save day sheet" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/^Published /).first()).toBeVisible();
  await expectAccessible(page);

  await page.goto(`/${slug}/show/call-sheets?create=1`);
  const call = page.getByRole("dialog", { name: "New call sheet" });
  await call.getByLabel("Day").fill("2027-03-13");
  await call.getByRole("button", { name: "Create call sheet" }).click();
  await page.waitForURL(/peek=/);
  await expect(page.getByText("No shifts start this day.")).toBeVisible();
  await page.getByRole("button", { name: "Publish to crew" }).click();
  await expect(page.getByText(/^Published /).first()).toBeVisible();
  await expectAccessible(page);
  await page.goto(`/${slug}/show/call-sheets?view=calendar&month=2027-03-01`);
  await expect(page.getByText("SHW call sheet")).toBeVisible();
  await expectAccessible(page);
});

test("every Schedule, Work and Show page passes axe in the light theme and answers 200", async ({
  page,
  context,
}) => {
  const slug = await newOwnerOrg(page);
  await context.addCookies([
    { name: "xos-theme", value: "light", domain: new URL(page.url()).hostname, path: "/" },
  ]);
  await page.goto(`/${slug}/work/all-records?create=1`);
  const sheet = page.getByRole("dialog", { name: "New record" });
  await sheet.getByLabel("Title").fill("Hang the truss");
  await sheet.getByLabel("Due").fill("2027-03-13T10:00");
  await sheet.getByRole("button", { name: "Create record" }).click();
  await page.waitForURL(/peek=SHW-1/);
  await expectAccessible(page);
  for (const path of [
    `/${slug}/schedule`,
    `/${slug}/schedule/timeline`,
    `/${slug}/schedule/calendar?month=2027-03-01`,
    `/${slug}/schedule/milestones`,
    `/${slug}/schedule/baselines`,
    `/${slug}/work`,
    `/${slug}/work/all-records?view=board`,
    `/${slug}/work/by-kind`,
    `/${slug}/work/work-orders`,
    `/${slug}/work/punch-lists`,
    `/${slug}/work/recurring`,
    `/${slug}/show`,
    `/${slug}/show/run-of-show`,
    `/${slug}/show/day-sheets`,
    `/${slug}/show/call-sheets`,
    `/${slug}/r/SHW-1`,
    `/${slug}/p/SHW/schedule`,
    `/${slug}/p/SHW/work`,
    `/${slug}/p/SHW/show`,
  ]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expectAccessible(page);
  }
  const missing = await page.goto(`/${slug}/r/SHW-999`);
  expect(missing?.status()).toBe(404);
});
