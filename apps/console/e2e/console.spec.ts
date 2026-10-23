import { expect, test } from "@playwright/test";
import {
  DEMO,
  expectAccessibleInBothThemes,
  newAccount,
  newOperator,
  passwordSignIn,
  reportedListing,
  signInOperator,
  sql,
} from "./support";

/**
 * Operator console journeys (A90, RRR-135, finding A65-009): sign-in refused for a non-operator, tenant search,
 * a flag override, a platform support session and a moderation decision. Each operator is made fresh and sets up
 * the authenticator app every console action needs.
 */

test("an account off the platform team is refused and signed out", async ({ page }) => {
  const email = await newAccount("tenant", "Tess Tenant");
  await passwordSignIn(page, email);
  await expect(page.getByTestId("sign-in-error")).toHaveText(
    "This console is for the XOS platform team, and your account is not on it, so you were signed out.",
  );
  await expectAccessibleInBothThemes(page);
  // Signed out: any console page sends them back to sign in.
  await page.goto("/tenants");
  await expect(page).toHaveURL(/\/auth\/sign-in/);
  // The demo Owner of a tenant is refused the same way.
  await passwordSignIn(page, "owner@example.com");
  await expect(page.getByTestId("sign-in-error")).toBeVisible();
});

test("Support searches tenants, opens one and overrides a flag with an expiry", async ({
  page,
}) => {
  const email = await newOperator("Support", "Sam Support");
  await signInOperator(page, email);
  await expect(page.getByTestId("operator")).toContainText("Sam Support, Support");
  // Support sees no moderation and no team roster in the top bar.
  const nav = page.getByRole("navigation", { name: "Console" });
  await expect(nav.getByRole("link", { name: "Moderation" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Platform Team" })).toHaveCount(0);

  await page.getByLabel("Name, slug or Owner email").fill("owner@example.com");
  await page.getByRole("button", { name: "Search" }).click();
  const results = page.getByTestId("tenant-results");
  await expect(results.getByRole("link", { name: "Demo Productions" })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  await results.getByRole("link", { name: "Demo Productions" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Demo Productions" })).toBeVisible();
  await expect(page.getByTestId("plan-in-force")).toBeVisible();
  await expectAccessibleInBothThemes(page);

  const flag = page.locator('[data-flag="imports.ai_mapping"]');
  await flag.locator("summary", { hasText: "Set override" }).click();
  const set = page.getByRole("form", { name: "Set override imports.ai_mapping" });
  await set.getByLabel("Value").selectOption("on");
  await set.getByLabel("Ends after").selectOption("14");
  await set.getByLabel("Reason").fill("Pilot of AI column mapping for the festival import.");
  await set.getByRole("button", { name: "Set override" }).click();
  await expect(set.getByText("Flag override saved.")).toBeVisible();
  await page.reload();
  await expect(
    page.locator('[data-flag="imports.ai_mapping"]').getByText(/Pilot of AI column mapping/),
  ).toBeVisible();

  const [row] = await sql<{ enabled: boolean; expires: boolean }>(
    `select o.enabled, o.expires_at between now() + interval '13 days' and now() + interval '15 days' as expires
       from app.feature_flag_overrides o where o.org_id = $1 and o.flag_key = 'imports.ai_mapping' and o.deleted_at is null`,
    [DEMO.org],
  );
  expect(row).toEqual({ enabled: true, expires: true });
  const [audit] = await sql<{ n: number }>(
    `select count(*)::int as n from app.audit_events a join app.people p on p.id = a.actor_person_id
       join auth.users u on u.id = p.user_id
      where a.org_id = $1 and a.action = 'feature_flag_overrides.insert' and u.email = $2`,
    [DEMO.org, email],
  );
  expect(audit?.n).toBe(1);
  // Clear it again, so the demo tenant stays as seeded.
  await page
    .locator('[data-flag="imports.ai_mapping"]')
    .locator("summary", { hasText: "Set override" })
    .click();
  const clear = page.getByRole("form", { name: "Clear override imports.ai_mapping" });
  await clear.getByLabel("Reason").fill("Pilot over.");
  await clear.getByRole("button", { name: "Clear override" }).click();
  // The page re-renders without the override, so its line and the clear form go with it.
  await expect(
    page.locator('[data-flag="imports.ai_mapping"]').getByText(/Pilot of AI column mapping/),
  ).toHaveCount(0);
  await expect(clear).toHaveCount(0);
  const [cleared] = await sql<{ n: number }>(
    `select count(*)::int as n from app.feature_flag_overrides
      where org_id = $1 and flag_key = 'imports.ai_mapping' and deleted_at is null`,
    [DEMO.org],
  );
  expect(cleared?.n).toBe(0);
});

test("Support opens an Owner-granted support session, reads the members and ends it", async ({
  page,
}) => {
  await sql(
    `update app.support_sessions set ended_at = now(), ended_by = $2
      where org_id = $1 and grantee = 'Platform' and ended_at is null and ends_at > now()`,
    [DEMO.org, DEMO.owner],
  );
  const [session] = await sql<{ id: string }>(
    `select app.grant_platform_support_session($1, 2, 'Imports of the crew list fail; please check our settings.') as id`,
    [DEMO.org],
    DEMO.owner,
  );
  const email = await newOperator("Support", "Sia Support");
  await signInOperator(page, email, "/support");
  const sessions = page.getByTestId("support-sessions");
  await expect(
    sessions.getByText("Imports of the crew list fail; please check our settings."),
  ).toBeVisible();
  await sessions.getByRole("link", { name: "Demo Productions" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Support session for Demo Productions" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Areas" })
    .getByRole("link", { name: "Members" })
    .click();
  await expect(page.getByTestId("support-area").getByText("owner@example.com")).toBeVisible();
  await expectAccessibleInBothThemes(page);

  const accesses = await sql<{ area: string }>(
    `select area::text from app.support_session_accesses where support_session_id = $1 order by accessed_at`,
    [session?.id],
  );
  expect(accesses.map((a) => a.area)).toEqual(["Overview", "Members"]);

  await page.getByRole("button", { name: "End the session" }).click();
  await page.waitForURL("**/support");
  await expect(page.getByText(/No platform support session is open/)).toBeVisible();
  await page.goto(`/support/${session?.id}?area=Members`);
  await expect(
    page.getByText("This support session has ended. The Owner can grant a new one."),
  ).toBeVisible();
});

test("Trust and Safety removes a reported listing with a statement of reasons", async ({
  page,
}) => {
  const listing = await reportedListing();
  const email = await newOperator("Trust and Safety", "Theo Safety");
  await signInOperator(page, email, "/moderation");
  const queue = page.getByTestId("moderation-queue");
  await expect(queue.getByRole("link", { name: listing.title })).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await queue.getByRole("link", { name: listing.title }).click();
  await expect(page.getByRole("heading", { level: 1, name: listing.title })).toBeVisible();

  const form = page.getByTestId("decide-listing");
  await form.getByLabel("Decision").selectOption("Removed");
  await form.getByLabel("Ground").selectOption("Terms Violation");
  await form
    .getByLabel("Law or rule relied on")
    .fill("Acceptable Use Policy, fees from applicants");
  await form
    .getByLabel("Facts and circumstances")
    .fill("The listing asks applicants to pay a registration fee before applying.");
  await form
    .getByLabel("Statement of reasons")
    .fill(
      "We removed this listing because it asks applicants to pay to apply. You may appeal within six months.",
    );
  await form.getByRole("button", { name: "Record the decision" }).click();
  await expect(form.getByText("Decision recorded and sent.")).toBeVisible();
  await expect(page.getByTestId("decisions")).toContainText("Removed");
  await expectAccessibleInBothThemes(page);

  const [decision] = await sql<{
    action: string;
    ground: string;
    operator: string;
    notified: number;
  }>(
    `select m.action::text, m.ground::text, u.email as operator,
       (select count(*)::int from app.notifications n where n.kind = 'listing.moderated' and n.subject_id = m.opportunity_id) as notified
       from app.moderation_actions m join app.people p on p.id = m.decided_by join auth.users u on u.id = p.user_id
      where m.opportunity_id = $1`,
    [listing.id],
  );
  expect(decision).toMatchObject({ action: "Removed", ground: "Terms Violation", operator: email });
  expect(decision?.notified).toBeGreaterThan(0);
});
