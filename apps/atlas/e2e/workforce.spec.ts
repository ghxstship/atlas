import { expect, test, type Page } from "./engine-test";
import { expectAccessibleInBothThemes, ORG, signIn } from "./a16-support";
import { uniqueId } from "./support";

/**
 * A29 Workforce Suite (Section 4.9) on the demo tenant (seeds 0010, 0107 and 0229): every page
 * renders its seeded content and is axe clean in both themes, and the Atlas side of journeys 64
 * (a required-read announcement to one group, acknowledged by a member while the manager sees who
 * has not), 65 (a form with conditional logic, a required photo and a signature, built and
 * published, its filler showing the conditional field; offline completion is the Compass mount)
 * and 67 (an occupancy counter alerting at 90 percent and a wind alert to named roles).
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
expect.configure({ timeout: 20_000 });

/** The seeded Northwind Summer Series project (seed 0107), where seed 0229 puts its site data. */
const DEMO_PROJECT = "01920000-0000-7000-8000-000000001001";

const PAGES: { path: string; heading: string; seeded: string }[] = [
  { path: "knowledge/feed", heading: "Feed", seeded: "Wristband Change Friday" },
  { path: "knowledge/handbook", heading: "Handbook", seeded: "Hearing Protection on Site" },
  { path: "knowledge/forms", heading: "Forms", seeded: "Rigging Pre-Use Check" },
  { path: "knowledge/training", heading: "Training", seeded: "Rigging Basics for Crew" },
  { path: "schedule/events", heading: "Events", seeded: "Show Day Safety Briefing" },
  { path: "people/groups", heading: "Groups", seeded: "Production Crew Space" },
  { path: "people/chat", heading: "Chat", seeded: "Production Crew Space" },
  { path: "people/recognition", heading: "Recognition", seeded: "stage left truss" },
  { path: "people/help-desk", heading: "Help Desk", seeded: "Dock tablet will not sign in" },
  {
    path: `site-ops/occupancy?project=${DEMO_PROJECT}`,
    heading: "Occupancy",
    seeded: "Pier Deck Doors",
  },
  {
    path: `site-ops/weather?project=${DEMO_PROJECT}`,
    heading: "Weather",
    seeded: "Emergency plan 4.2",
  },
  {
    path: `site-ops/guest-check-in?project=${DEMO_PROJECT}`,
    heading: "Guest Check-In",
    seeded: "Avery Brooks",
  },
  {
    path: `site-ops/lost-and-found?project=${DEMO_PROJECT}`,
    heading: "Lost and Found",
    seeded: "Brown leather wallet",
  },
];

async function open(page: Page, path: string, heading: string) {
  await page.goto(`/${ORG}/${path}`);
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

for (const p of PAGES) {
  test(`${p.heading} renders the seeded content and passes axe in both themes`, async ({
    page,
  }) => {
    await signIn(page, "admin@example.com");
    await open(page, p.path, p.heading);
    await expect(page.getByText(p.seeded).first()).toBeVisible();
    await expectAccessibleInBothThemes(page);
  });
}

test("journey 64: a required-read announcement to one group, acknowledged, with who has not", async ({
  page,
  browser,
}) => {
  const headline = `Radio Check ${uniqueId()}`;
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/knowledge/feed?create=1`);
  const drawer = page.getByRole("dialog", { name: "New post" });
  // Checked before typing: the theme switch reloads the page and clears the form.
  await expectAccessibleInBothThemes(page);
  await drawer.getByLabel("Kind", { exact: true }).selectOption("Announcement");
  await drawer.getByLabel("Headline").fill(headline);
  await drawer.getByLabel("Post", { exact: true }).fill("Radios on channel 4 from load-in.");
  await drawer.getByLabel("Audience", { exact: true }).selectOption("Group");
  await drawer
    .getByLabel("Audience target")
    .selectOption({ label: "Group: Production Crew Space" });
  await drawer.getByLabel("Ask everyone to acknowledge it").check();
  await drawer.getByRole("button", { name: "Post", exact: true }).click();
  await expect(drawer).toBeHidden();
  const card = page.locator("section").filter({ hasText: headline }).last();
  await expect(card).toContainText("Production Crew Space");

  // The field member acknowledges it from the feed.
  const field = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signIn(field, "field@example.com");
  await field.goto(`/${ORG}/knowledge/feed`);
  const theirs = field.locator("section").filter({ hasText: headline }).last();
  await theirs.getByRole("button", { name: "Acknowledge" }).click();
  await expect(theirs).toContainText("You acknowledged this.");
  await expectAccessibleInBothThemes(field);

  // The manager sees who acknowledged and who has not.
  await page.goto(`/${ORG}/knowledge/feed`);
  await page
    .locator("section")
    .filter({ hasText: headline })
    .last()
    .getByRole("link", { name: "Comments" })
    .click();
  const peek = page.getByRole("dialog").filter({ hasText: "Who acknowledged" });
  await expect(peek).toContainText("Demo Field Lead acknowledged on");
  await expect(peek).toContainText("Demo Admin has not acknowledged yet");
  await expectAccessibleInBothThemes(page);
});

test("journey 65: a form with conditional logic, a required photo and a signature, built and published", async ({
  page,
}) => {
  const name = `Truss Pre-Use Check ${uniqueId()}`;
  await signIn(page, "admin@example.com");
  await page.goto(`/${ORG}/knowledge/forms?create=1`);
  const drawer = page.getByRole("dialog", { name: "New form" });
  await drawer.getByLabel("Name", { exact: true }).fill(name);
  await drawer.getByLabel("Record kind").selectOption({ index: 1 });
  await drawer
    .getByLabel("Fields", { exact: true })
    .fill(
      [
        "Truss inspected | yes_no | required | points true=2",
        "Defect found | long_text | required | if truss_inspected = false",
        "Photos of the truss | photo | required",
      ].join("\n"),
    );
  await drawer.getByLabel("Needs a signature").check();
  await drawer.getByRole("button", { name: "New form" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  await page.getByRole("button", { name: "Publish", exact: true }).first().click();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  const fill = page.getByRole("region", { name: "Fill in" });
  await expect(fill).toBeVisible();

  // The defect field appears only when the truss fails inspection.
  await expect(fill.getByLabel(/^Defect found/)).toHaveCount(0);
  await fill.getByRole("radio", { name: "No" }).check();
  await expect(fill.getByLabel(/^Defect found/)).toBeVisible();
  await fill.getByRole("radio", { name: "Yes" }).check();
  await expect(fill.getByLabel(/^Defect found/)).toHaveCount(0);
  await expectAccessibleInBothThemes(page);
});

test("journey 67: occupancy alerts at 90 percent, and a wind alert reaches the named roles", async ({
  page,
}) => {
  const counter = `Gate C ${uniqueId()}`;
  await signIn(page, "admin@example.com");
  await page.goto(`/${ORG}/site-ops/occupancy?project=${DEMO_PROJECT}&create=1`);
  const drawer = page.getByRole("dialog", { name: "New counter" });
  await drawer.getByLabel("Counter name").fill(counter);
  await drawer.getByLabel("Permitted load from a permit").fill("10");
  await drawer.getByRole("button", { name: "New counter" }).click();
  await expect(drawer).toBeHidden();

  await page.goto(`/${ORG}/site-ops/occupancy?project=${DEMO_PROJECT}&view=list`);
  await page
    .getByRole("row")
    .filter({ hasText: counter })
    .getByRole("button", { name: "Open" })
    .click();
  const peek = page.getByRole("dialog", { name: counter });
  const count = peek.getByRole("group", { name: `Count for ${counter}` });
  await count.getByRole("button", { name: "In 5" }).click();
  await expect(peek.getByRole("status")).toHaveText("5 of 10 (50%)");
  for (const expected of ["6 of 10 (60%)", "7 of 10 (70%)", "8 of 10 (80%)", "9 of 10 (90%)"]) {
    await count.getByRole("button", { name: "In 1" }).click();
    await expect(peek.getByRole("status")).toHaveText(expected);
  }
  await expect(peek).toContainText("At 90%");
  await expectAccessibleInBothThemes(page);

  // Weather: name a role for Evacuate, then a gust past the seeded 40 mph threshold alerts.
  await page.goto(`/${ORG}/site-ops/weather?project=${DEMO_PROJECT}`);
  const roles = page.locator("#weather-role-form");
  await roles.getByLabel("Level").selectOption("Evacuate");
  await roles.getByLabel("Canon role").selectOption({ index: 1 });
  await roles.getByRole("button", { name: "Add role" }).click();
  await expect(page.getByRole("region", { name: "Who is alerted" })).toContainText("Evacuate:");
  const reading = page.locator("#weather-reading-form");
  await reading.getByLabel("Hazard").selectOption("Wind");
  await reading.getByLabel("Reading").fill("45");
  await reading.getByRole("button", { name: "Record reading" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Wind gusts Evacuate since" }),
  ).toBeVisible();
  await expectAccessibleInBothThemes(page);
});
