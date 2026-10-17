import { expect as baseExpect, test } from "@playwright/test";
import { ATLAS_URL } from "./atlas";
import { asPerson } from "./role-fixtures";
import { DEMO_PASSWORD, expectAccessible, sql } from "./support";

/**
 * One person across the surfaces (Section 20.2), with seed 1080's multi@example.com: a Producer
 * and member of Demo Productions, Admin of Demo Bayside Studios, crew for Demo Harbor Events and
 * artist for Demo Night Festival.
 *   48  one sign-in reaches Atlas and Gateway, and each shows only its own context. Locally both
 *       apps answer on 127.0.0.1, so the session Atlas sets is the one Gateway reads; deployed,
 *       each host keeps its own cookie for the same account. Compass needs a device.
 *   59  context switches in Atlas and Gateway, the union of roles in each org, and the person
 *       cannot approve their own expense in Demo Productions whichever role they act under.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const GATEWAY = process.env["E2E_GATEWAY_URL"] ?? "http://127.0.0.1:3127";
const MULTI = "01920000-0000-7000-8000-000010800110";

test("journey 48: one sign-in, Atlas and Gateway each in their own context", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${ATLAS_URL}/auth/sign-in?next=${encodeURIComponent("/demo-productions/home")}`);
  await page.locator("#signin-email").fill("multi@example.com");
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL("**/demo-productions/home");
  // Atlas: the org's own workspace, its modules and projects.
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Demo Productions" }).first()).toBeVisible();

  // Gateway with the same sign-in: no second sign-in, and only the person's external work.
  await page.goto(`${GATEWAY}/work/engagements?view=list`);
  await expect(page).toHaveURL(/\/work\/engagements/);
  await expect(page.getByRole("button", { name: "Sign in with password" })).toHaveCount(0);
  await expect(page.getByText("Demo Harbor Events").first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await expect(page.getByText("Demo Productions")).toHaveCount(0);
  await expectAccessible(page);
  await context.close();
});

test("journey 59: four orgs, the union of roles in each, and no approving one's own expense", async ({
  browser,
}) => {
  const atlas = await browser.newContext({ baseURL: ATLAS_URL, reducedMotion: "reduce" });
  const page = await atlas.newPage();
  await page.goto(`/auth/sign-in?next=${encodeURIComponent("/demo-productions/home")}`);
  await page.locator("#signin-email").fill("multi@example.com");
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL("**/demo-productions/home");

  // Demo Productions: Producer and member. Finance opens; module switches are an Admin's.
  await page.goto("/demo-productions/finance");
  await expect(page.getByRole("heading", { level: 1, name: "Finance" })).toBeVisible();
  await page.goto("/demo-productions/settings/modules");
  await expect(page.getByRole("button", { name: "Save modules" })).toHaveCount(0);

  // Switch to Demo Bayside Studios from the org switcher: there they are Admin.
  await page.goto("/demo-productions/home");
  await page
    .getByRole("button", { name: "Demo Productions", exact: true })
    .click({ timeout: 20_000 });
  const bayside = page.getByRole("menuitemradio", { name: /Demo Bayside Studios/ });
  await expect(bayside).toContainText("Admin");
  await expect(page.getByRole("menuitemradio", { name: /Demo Productions/ })).toBeVisible();
  // Crew and artist work is external: those orgs are Gateway's, never Atlas memberships.
  await expect(page.getByRole("menuitemradio", { name: /Demo Harbor Events/ })).toHaveCount(0);
  await bayside.click();
  await page.waitForURL("**/demo-bayside-studios/**");
  await page.goto("/demo-bayside-studios/settings/modules");
  await expect(page.getByRole("button", { name: "Save modules" })).toBeVisible();
  await expectAccessible(page);

  // Back in Demo Productions, an expense they submit cannot be approved by them.
  await page.goto("/demo-productions/finance/expenses?project=NWS&create=1");
  const create = page.getByRole("dialog", { name: "New expense" });
  await create.locator("#expense-line").click();
  await expect(page.getByRole("listbox").getByRole("option").first()).toBeVisible();
  await create.locator("#expense-line").press("Enter");
  await create.getByLabel("Description").fill(`Radio batteries ${Date.now().toString(36)}`);
  await create.locator("#expense-amount").fill("48.00");
  await create.getByLabel("Incurred on").fill("2027-06-04");
  await create.getByRole("button", { name: "New expense" }).click();
  await page.waitForURL(/peek=/);
  const expense = new URL(page.url()).searchParams.get("peek") ?? "";
  await expect(
    page.getByText("You submitted this expense, so someone else approves it."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(
    asPerson(MULTI, `select app.approve_expense($1, 'Approving my own.')`, [expense]),
  ).rejects.toThrow();
  const [state] = await sql<{ s: string }>(
    `select expense_state::text as s from app.expenses where id = $1`,
    [expense],
  );
  expect(state?.s).not.toBe("Approved");
  await atlas.close();

  // Gateway: the crew and artist engagements, one per org, filterable by org.
  const gateway = await browser.newContext({ baseURL: GATEWAY, reducedMotion: "reduce" });
  const g = await gateway.newPage();
  await g.goto("/auth/sign-in?next=%2Fwork%2Fengagements");
  await g.locator("#signin-email").fill("multi@example.com");
  await g.locator("#signin-password").fill(DEMO_PASSWORD);
  await g.getByRole("button", { name: "Sign in with password" }).click();
  await g.waitForURL("**/work/engagements**");
  await g.goto("/work/engagements?view=list");
  await expect(g.getByText("Demo Harbor Events").first()).toBeVisible();
  await expect(g.getByText("Demo Night Festival").first()).toBeVisible();
  await expectAccessible(g);
  await gateway.close();
});
