import { expect, test, type Page } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A07 journeys (Section 20.2): 1 (create a project with its jurisdiction, then generate its permit
 * requirements with lead times), 2 (a gate refused with
 * the named criterion, then passed on evidence), 22 (gate 8 blocked by uncleared rights) and 23
 * (closing the project at gate 9), plus the Projects, Home and Activity pages in both themes.
 * Each run signs up a new owner in a new org on the local stack, so runs never collide.
 */

// Dialogs and peeks fade in; axe measures contrast mid-fade unless motion is reduced, so these
// checks run with reduced motion, which the design system honors with no animation.
test.use({ reducedMotion: "reduce" });

async function newOwnerOrg(page: Page): Promise<string> {
  const id = uniqueId();
  const slug = `prj-${id}`;
  await signUp(page, { name: "Pat Producer", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Projects ${id}`, slug });
  return slug;
}

async function createProject(page: Page, slug: string, key: string, name: string) {
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);
  await dialog.getByLabel("Project key").fill(key);
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "More fields" }).click();
  await dialog.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await dialog.getByLabel("Tier of experience").selectOption({ index: 5 });
  await dialog.getByLabel("First production day").fill("2027-03-12");
  await dialog.getByLabel("Last production day").fill("2027-03-15");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/${key}/overview`);
}

/** Attests rank 4 evidence for one criterion from the Gates tab. */
async function attest(page: Page, criterion: string) {
  // The button and dialog name the criterion by its sentence; its row carries the code (A59-017).
  await page
    .locator("li")
    .filter({ has: page.locator(".font-mono", { hasText: criterion }) })
    .last()
    .getByRole("button", { name: /^Attest evidence for / })
    .click();
  const dialog = page.getByRole("dialog", { name: /^Attest evidence for / });
  await expect(dialog).toContainText(`Criterion ${criterion}`);
  await dialog
    .getByLabel("Document link or record key")
    .fill(`https://docs.example.com/${criterion.toLowerCase().replace(/[._]/g, "-")}.pdf`);
  await dialog.getByLabel("What it shows").fill("Signed off by the accountable party.");
  await dialog.getByRole("button", { name: "Attest" }).click();
  await expect(dialog).toBeHidden();
}

async function passGate(page: Page, gate: number, decision: string) {
  await page.getByRole("button", { name: `Pass gate ${gate}` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Decision").fill(decision);
  await dialog.getByRole("button", { name: "Pass gate" }).click();
  return dialog;
}

/** Blocking criteria shown for the current gate, read from the Gates tab. */
async function blockingCriteria(page: Page, gate: number): Promise<string[]> {
  const section = page.locator(`section[aria-labelledby="gate-${gate}"]`);
  const ids = await section
    .locator("li")
    .filter({ hasText: "Blocking" })
    .locator(".font-mono")
    .allTextContents();
  return ids.map((s) => s.trim()).filter((s) => s.startsWith(`G${gate}.`));
}

async function clearGate(page: Page, gate: number, skip: readonly string[] = []) {
  for (const id of await blockingCriteria(page, gate)) {
    if (!skip.includes(id)) await attest(page, id);
  }
}

test("journey 1: create a project with jurisdiction US-FL-MIAMI-DADE", async ({ page }) => {
  const slug = await newOwnerOrg(page);
  await page.goto(`/${slug}/projects/all`);
  await expect(page.getByText("No projects yet.")).toBeVisible();
  await expectAccessible(page);
  await createProject(page, slug, "NWL", "Northwind Summer Series");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByText("US-FL-MIAMI-DADE")).toBeVisible();
  await expect(page.getByText("Gate 1 · Scope").first()).toBeVisible();
  await expectAccessible(page);
  // The project is created with its engagement root.
  await page.goto(`/${slug}/p/NWL/scope`);
  await expect(page.getByRole("tree", { name: "Scope tree of NWL" })).toContainText("NWL-E01");
  await expectAccessible(page);
  // The list, board, timeline and calendar show it.
  for (const view of ["table", "list", "board", "gallery"]) {
    await page.goto(`/${slug}/projects/all?view=${view}`);
    await expect(page.getByText("Northwind Summer Series").first()).toBeVisible();
    await expectAccessible(page);
  }
  // The peek opens from the URL and from a row, and closes with Escape.
  await page.goto(`/${slug}/projects/all?peek=NWL`);
  const peek = page.getByRole("dialog", { name: "NWL Northwind Summer Series" });
  await expect(peek).toContainText("US-FL-MIAMI-DADE");
  // Park the pointer so no button is measured in its hover state.
  await page.mouse.move(0, 0);
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();
  await expect(page).not.toHaveURL(/peek=/);
  await page.goto(`/${slug}/projects/portfolio-timeline`);
  await expect(page.getByRole("figure", { name: "Portfolio timeline" })).toBeVisible();
  await expectAccessible(page);
  // A new org's plan includes one active project (ADR 0018): a second is refused with words that
  // name the next step, and the typed input stays (the refusal state).
  await page.goto(`/${slug}/projects/all?create=1`);
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill("NWM");
  await dialog.getByLabel("Project name").fill("Second Project");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog.getByRole("alert")).toContainText("active project limit");
  await expect(dialog.getByLabel("Project name")).toHaveValue("Second Project");
  await page.mouse.move(0, 0);
  await expectAccessible(page);
});

test("journey 2: a gate is refused with the named criterion, then passes on evidence", async ({
  page,
}) => {
  const slug = await newOwnerOrg(page);
  await createProject(page, slug, "GTE", "Gate Trial Expo");
  await page.goto(`/${slug}/p/GTE/gates`);
  await expectAccessible(page);

  // Attest everything but the go or no-go decision: the gate is refused and names it.
  await clearGate(page, 1, ["G1.GONOGO"]);
  const dialog = await passGate(page, 1, "Scope review held with the client.");
  await expect(dialog.getByRole("alert")).toContainText("G1.GONOGO");
  await expect(dialog.getByLabel("Decision")).toHaveValue("Scope review held with the client.");
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await attest(page, "G1.GONOGO");
  const again = await passGate(page, 1, "Go decision ratified by the executive producer.");
  await expect(again).toBeHidden();
  await expect(page.locator('section[aria-labelledby="gate-1"]')).toContainText("Passed");
  await expect(page.getByText("Gate 2 · Engage").first()).toBeVisible();
  await expect(page.getByText("Gate 1: Scope to Engage")).toBeVisible();

  // The activity feed and Home show what happened.
  await page.goto(`/${slug}/p/GTE/activity`);
  await expect(page.getByText("passed a gate on").first()).toBeVisible();
  await expectAccessible(page);
  await page.goto(`/${slug}/home/gate-readiness`);
  await expect(page.getByText("Gate Trial Expo")).toBeVisible();
  await expectAccessible(page);
});

test("journeys 22 and 23: uncleared rights block gate 8, then the project closes at gate 9", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const slug = await newOwnerOrg(page);
  await createProject(page, slug, "AMP", "Amplify Showcase");
  await page.goto(`/${slug}/p/AMP/gates`);
  for (let gate = 1; gate <= 7; gate += 1) {
    await clearGate(page, gate);
    await expect(await passGate(page, gate, `Gate ${gate} reviewed and accepted.`)).toBeHidden();
  }

  // Journey 22: capture delivered and sponsor obligations evidenced, rights not cleared.
  await clearGate(page, 8, ["G8.RIGHTS_CLEARED"]);
  const blocked = await passGate(page, 8, "Amplify review held.");
  await expect(blocked.getByRole("alert")).toContainText("G8.RIGHTS_CLEARED");
  await blocked.getByRole("button", { name: "Cancel" }).click();
  await attest(page, "G8.RIGHTS_CLEARED");
  await expect(await passGate(page, 8, "Rights cleared for every published asset.")).toBeHidden();
  await expect(page.locator('section[aria-labelledby="gate-8"]')).toContainText("Passed");

  // Journey 23: reconciliation, asset return and usage recorded close the project.
  await clearGate(page, 9);
  await attest(page, "G9.USAGE_RECORDED");
  await expect(
    await passGate(page, 9, "Final cost report filed against the gate 3 baseline."),
  ).toBeHidden();
  await expect(page.getByText("Gate 9: Close closed")).toBeVisible();
  await page.goto(`/${slug}/p/AMP/overview`);
  await expect(page.getByText("Every gate is passed. The project rests in Close.")).toBeVisible();
  await expectAccessible(page);
});

test("Projects, Home and Activity pages pass axe in the light theme", async ({ page, context }) => {
  const slug = await newOwnerOrg(page);
  await createProject(page, slug, "LTE", "Light Theme Evening");
  await context.addCookies([
    { name: "xos-theme", value: "light", domain: new URL(page.url()).hostname, path: "/" },
  ]);
  for (const path of [
    `/${slug}/home`,
    `/${slug}/home/today`,
    `/${slug}/home/gate-readiness`,
    `/${slug}/home/alerts`,
    `/${slug}/home/recent`,
    `/${slug}/projects`,
    `/${slug}/projects/by-phase`,
    `/${slug}/p/LTE/overview`,
    `/${slug}/p/LTE/scope`,
    `/${slug}/p/LTE/gates?view=board`,
    `/${slug}/p/LTE/activity`,
    `/${slug}/p/LTE/settings`,
    `/${slug}/activity/feed`,
    `/${slug}/activity/audit-log`,
  ]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expectAccessible(page);
  }
});

test("journey 1: generate permit requirements from the permit engine and see lead times", async ({
  page,
}) => {
  const slug = await newOwnerOrg(page);
  await createProject(page, slug, "PRM", "Permit Engine Series");
  // A09's Safety tab runs the canon permit engine for the project's jurisdiction.
  await page.goto(`/${slug}/p/PRM/safety`);
  await expect(page.getByRole("heading", { name: "Permit engine for PRM" })).toBeVisible();
  await page.getByRole("button", { name: "Generate permit requirements" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /Added \d+ requirements\./ }),
  ).toBeVisible();
  await expect(page.getByText("Special Events Permit")).toBeVisible();
  await expect(page.getByText(/Lead time \d+-\d+ wks/).first()).toBeVisible();
  await expectAccessible(page);
  await page.goto(`/${slug}/p/PRM/safety?view=table`);
  await expect(page.getByRole("gridcell", { name: /wks$/ }).first()).toBeVisible();
  await expectAccessible(page);
});

// Journey 14 (dependencies, baseline, slip and the logged replan) runs in schedule-work.spec.ts.

test("a project the viewer cannot read answers 404", async ({ page }) => {
  const slug = await newOwnerOrg(page);
  const res = await page.goto(`/${slug}/p/ZZZ/overview`);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
