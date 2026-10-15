import { expect, test, type Page } from "@playwright/test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A09 Safety journeys (Section 20.2): 1, the permit step (a project in US-FL-MIAMI-DADE generates its
 * permit requirements from the canon permit engine and shows each lead time; a project without a
 * jurisdiction answers NO_ANSWER), and 17 (run an inspection template, fail an item, see the punch
 * record created), with sign-off separation, the Safety landing and every page in both themes.
 */

test.use({ reducedMotion: "reduce" });

const ORG = "demo-productions";
const DEMO_PASSWORD = `xos-demo-${"2026"}`;

async function signIn(page: Page, email: string) {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${ORG}/home`)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL(`**/${ORG}/home`);
}

async function expectAccessibleInBothThemes(page: Page) {
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "light", url: page.url() }]);
  await page.reload();
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "dark", url: page.url() }]);
  await page.reload();
}

async function createProject(page: Page, slug: string, key: string, jurisdiction: string | null) {
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill(key);
  await dialog.getByLabel("Project name").fill(`Permit Test ${key}`);
  if (jurisdiction) await dialog.getByLabel("Jurisdiction").selectOption(jurisdiction);
  await dialog.getByLabel("Tier of experience").selectOption({ index: 5 });
  await dialog.getByLabel("First production day").fill("2027-03-12");
  await dialog.getByLabel("Last production day").fill("2027-03-15");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/${key}/overview`);
}

test("journey 1, permit step: generate permits from canon for Miami-Dade and see lead times", async ({
  page,
}) => {
  const id = uniqueId();
  const slug = `saf-${id}`;
  await signUp(page, { name: "Sam Safety", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Safety ${id}`, slug });
  await createProject(page, slug, "MIA", "US-FL-MIAMI-DADE");

  await page.goto(`/${slug}/p/MIA/safety`);
  await expect(page.getByRole("heading", { name: "Permit engine for MIA" })).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await page.getByRole("button", { name: "Generate permit requirements" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /Added \d+ requirements\./ }),
  ).toBeVisible();
  await expect(page.getByText("Special Events Permit")).toBeVisible();
  await expect(page.getByText("Lead time 4-6 wks").first()).toBeVisible();
  await expectAccessible(page);

  // Running it again adds nothing.
  await page.getByRole("button", { name: "Generate permit requirements" }).click();
  await expect(
    page.getByText("Nothing new: every applicable rule is already listed."),
  ).toBeVisible();

  // Track one with a Permit record and move it along the record lifecycle.
  await page
    .getByRole("link", { name: /Special Events Permit/ })
    .first()
    .click();
  const peek = page.getByRole("dialog", { name: "Permit requirement" });
  await expect(peek.getByText("City of Miami Special Events Office")).toBeVisible();
  await peek.getByRole("button", { name: "Track with a Permit record" }).click();
  await expect(peek.getByRole("heading", { name: "The issued permit" })).toBeVisible();
  await expectAccessible(page);
  await peek.getByLabel("New state").selectOption("Scheduled");
  await peek.getByLabel("Reason").fill("Application filed with the Special Events Office.");
  await peek.getByRole("button", { name: "Change state" }).click();
  await expect(peek.getByText("State changed.")).toBeVisible();
  await peek.getByLabel("Permit number").fill("SE-2027-0142");
  await peek.getByRole("button", { name: "Save permit details" }).click();
  await expect(peek.getByText("Permit details saved.")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(`/${slug}/p/MIA/safety?view=table`);
  await expect(page.getByRole("gridcell", { name: "4-6 wks" }).first()).toBeVisible();
  await page.goto(`/${slug}/p/MIA/safety?view=board`);
  await expect(page.getByText("Special Events Permit").first()).toBeVisible();
  await expectAccessible(page);
});

test("permit engine: a project without a jurisdiction answers NO_ANSWER and never passes", async ({
  page,
}) => {
  const id = uniqueId();
  const slug = `noj-${id}`;
  await signUp(page, { name: "Nia Noanswer", email: testEmail("owner", id) });
  await createOrganization(page, { name: `No Answer ${id}`, slug });
  await createProject(page, slug, "NOJ", null);
  await page.goto(`/${slug}/p/NOJ/safety`);
  await expect(page.getByText("No answer for NOJ")).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate permit requirements" })).toHaveCount(0);
  await expectAccessibleInBothThemes(page);
});

test("journey 17: run an inspection template, fail an item, see the punch record, sign off by another person", async ({
  page,
  browser,
}) => {
  const id = uniqueId();
  const template = `Stage Walk ${id}`;
  await signIn(page, "owner@example.com");

  await page.goto(`/${ORG}/safety`);
  await expect(page.getByRole("heading", { level: 1, name: "Safety" })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  await page.goto(`/${ORG}/safety/inspection-templates?create=1`);
  const create = page.getByRole("dialog", { name: "Add template" });
  await create.getByLabel("Template name").fill(template);
  await create.getByRole("button", { name: "Add template" }).click();
  const peek = page.getByRole("dialog", { name: "Inspection template" });
  await expect(peek.getByRole("heading", { name: template })).toBeVisible();
  await peek.getByLabel("New item: what is checked").fill("Deck edges guarded");
  await peek.getByLabel("Critical: a failure stops use").check();
  await peek.getByRole("button", { name: "Add item" }).click();
  await expect(peek.getByText("Deck edges guarded").first()).toBeVisible();
  await peek.getByLabel("New item: what is checked").fill("Exits clear and lit");
  await peek.getByRole("button", { name: "Add item" }).click();
  await expect(peek.getByRole("button", { name: "Move up: Exits clear and lit" })).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press("Escape");

  await page.goto(`/${ORG}/safety/inspections?create=1`);
  const start = page.getByRole("dialog", { name: "Start inspection" });
  await start.getByLabel("Template").selectOption({ label: template });
  await start.getByRole("button", { name: "Start inspection" }).click();
  await expect(page.getByRole("heading", { level: 1, name: template })).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel("Result for item 1").selectOption({ label: "Failed" });
  await page.getByLabel("Finding for item 1").fill("Rail missing at stage left.");
  await page.getByRole("button", { name: "Save item 1" }).click();
  await expect(
    page.getByText(/A punch item, [A-Z]{2,5}-\d+, was opened to correct this\./),
  ).toBeVisible();
  await page.getByLabel("Result for item 2").selectOption({ label: "Passed" });
  await page.getByRole("button", { name: "Save item 2" }).click();
  await expect(page.getByText("Items answered: 2 of 2")).toBeVisible();

  // The inspector cannot sign off their own inspection.
  await page.getByRole("button", { name: "Sign off" }).click();
  await page
    .getByRole("dialog", { name: `Sign off ${template}?` })
    .getByRole("button", { name: "Sign off" })
    .click();
  await expect(page.getByText("The inspector cannot sign off their own inspection.")).toBeVisible();
  const runnerUrl = page.url();

  // Another person with sign-off rights signs it off, and the results freeze.
  const admin = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signIn(admin, "admin@example.com");
  await admin.goto(runnerUrl);
  await admin.getByRole("button", { name: "Sign off" }).click();
  await admin
    .getByRole("dialog", { name: `Sign off ${template}?` })
    .getByRole("button", { name: "Sign off" })
    .click();
  await expect(admin.getByText("Signed off. The results are frozen")).toBeVisible();
  await expect(admin.getByRole("button", { name: "Save item 1" })).toHaveCount(0);
  await expectAccessible(admin);

  await page.goto(`/${ORG}/safety/inspections?view=board`);
  await expectAccessibleInBothThemes(page);
  await page.goto(`/${ORG}/safety/inspections?view=calendar`);
  await expect(page.getByRole("button", { name: new RegExp(template) }).first()).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await page.goto(`/${ORG}/safety/permits`);
  await expectAccessibleInBothThemes(page);
});
