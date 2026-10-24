import pg from "pg";
import { expect, settle, test, type Page } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * RRR-58, org side: the engagement lifecycle in the Atlas Opportunities module from requisition to re-engagement, on
 * the demo tenant seed (supabase/seeds/0010 and 0228). Each page is checked with axe in both themes. The demo
 * Producer (Manager) drives the journeys; the demo crew person is the engaged party.
 */

const ORG = "demo-productions";
const NOT_FOUND_TITLE = "Page not found";
const DEMO_PASSWORD = `xos-demo-${"2026"}`;

async function signInAsProducer(page: Page, email = "producer@example.com") {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${ORG}/home`)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL(`**/${ORG}/home`);
}

/** axe in dark (the default) and light (Section 18, gate 8: both themes). */
async function expectAccessibleInBothThemes(page: Page) {
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "light", url: page.url() }]);
  await page.reload();
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "dark", url: page.url() }]);
  await page.reload();
  // Leave the page hydrated: callers act next, and a click before hydration is lost (A71, A77).
  await settle(page);
}

/** Reads and writes the local stack directly, for the org settings Atlas has no screen for yet (spend limits). */
async function localSql<T extends pg.QueryResultRow>(text: string, args: unknown[]): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url))
    throw new Error("Set E2E_DATABASE_URL to the local stack.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, args)).rows;
  } finally {
    await client.end();
  }
}

/** A Crew posting saved as a draft with only a title and a pay range, opened on its detail page. */
async function draftPosting(page: Page, label: string): Promise<string> {
  await page.goto(`/${ORG}/opportunities/postings?create=1`);
  const title = `${label} ${Date.now().toString(36).toUpperCase()}`;
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Rate type").selectOption("Day");
  await page.getByLabel("Lowest pay").fill("900.00");
  await page.getByLabel("Highest pay").fill("950.00");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();
  await page.goto(`/${ORG}/opportunities/postings`);
  await page.getByRole("link", { name: title }).click();
  await page.waitForURL(/postings\?.*id=/);
  return title;
}

/** Moves the open posting to Pending Approval, then asks to publish it. */
async function publishFromDetail(page: Page) {
  const move = page.getByRole("form", { name: "Move to" });
  await move.getByLabel("Next state").selectOption("Pending Approval");
  await move.getByLabel("Reason").fill("Ready.");
  await move.getByRole("button", { name: "Move" }).click();
  await expect(page.getByText("Pending Approval").first()).toBeVisible();
  await move.getByLabel("Next state").selectOption("Published");
  await move.getByLabel("Reason").fill("Publish.");
  await move.getByRole("button", { name: "Move" }).click();
}

test.describe("Opportunities, org side", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsProducer(page);
  });

  test("requisition to published posting, and a posting without a requisition only where requisition limits are set", async ({
    page,
  }) => {
    await page.goto(`/${ORG}/opportunities/requisitions`);
    await expect(page.getByRole("heading", { level: 1, name: "Requisitions" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page.getByRole("link", { name: "Post opportunity" }).first().click();
    await expect(page.getByText("New posting", { exact: true }).first()).toBeVisible();
    const title = `Festival Riggers ${Date.now().toString(36).toUpperCase()}`;
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByLabel("Rate type").selectOption("Day");
    await page.getByLabel("Lowest pay").fill("900.00");
    await page.getByLabel("Highest pay").fill("950.00");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();

    await page.goto(`/${ORG}/opportunities/postings?view=table`);
    await expectAccessibleInBothThemes(page);
    await page.getByRole("link", { name: title }).click();
    await page.waitForURL(/postings\?.*id=/);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page.getByLabel("Position", { exact: true }).fill("Rigger 3");
    await page.getByRole("button", { name: "Add position" }).click();
    await expect(page.getByText("Rigger 3", { exact: true })).toBeVisible();

    const moveTo = page.getByRole("form", { name: "Move to" });
    await moveTo.getByLabel("Next state").selectOption("Pending Approval");
    await moveTo.getByLabel("Reason").fill("Ready for approval.");
    await moveTo.getByRole("button", { name: "Move" }).click();
    await expect(page.getByText("Pending Approval").first()).toBeVisible();
    await moveTo.getByLabel("Next state").selectOption("Published");
    await moveTo.getByLabel("Reason").fill("Approved within the requisition.");
    await moveTo.getByRole("button", { name: "Move" }).click();
    await expect(page.getByText("Published").first()).toBeVisible();

    // Spend authority before publishing applies only where the org sets spend limits for requisitions (ADR 0033
    // decision 61, migration 1623). The demo org sets limits for other documents only, so a Crew posting without a
    // requisition publishes.
    const loose = await draftPosting(page, "Loose Crew Call");
    await publishFromDetail(page);
    await expect(page.getByText("Published").first()).toBeVisible();
    await expect
      .poll(async () => {
        const [row] = await localSql<{ state: string; requisition: string | null }>(
          `select opportunity_state::text as state, requisition_id::text as requisition
             from app.opportunities where title = $1`,
          [loose],
        );
        return row;
      })
      .toEqual({ state: "Published", requisition: null });

    // Once the org sets a requisition limit, a Crew posting without a requisition is refused at publishing, with copy
    // that names the fix.
    const [limit] = await localSql<{ id: string }>(
      `insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor)
       select o.id, r.id, 'Requisition', 'USD', 5000000 from app.organizations o, app.roles r
        where o.slug = $1 and r.org_id is null and r.code = 'manager'
       returning id`,
      [ORG],
    );
    try {
      await draftPosting(page, "Limited Crew Call");
      await publishFromDetail(page);
      await expect(page.getByText("publish only from an Approved requisition")).toBeVisible();
      await expectAccessible(page);
    } finally {
      await localSql(`delete from app.spend_authorities where id = $1`, [limit?.id]);
    }
  });

  test("pipeline to engagement, onboarding verification, activation and a signing link", async ({
    page,
  }) => {
    await page.goto(`/${ORG}/opportunities/pipeline`);
    await expect(page.getByRole("heading", { level: 1, name: "Pipeline" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page
      .getByRole("link", { name: /Demo Crew Member/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Demo Crew Member" })).toBeVisible();
    await expect(page.getByText("Accepted").first()).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page.getByRole("link", { name: "Open the engagement" }).click();
    await page.waitForURL(/\/opportunities\/engagements\?id=/);

    await expect(page.getByRole("heading", { level: 1, name: "Demo Crew Member" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
    // Active is refused while the blocking Certificate of Insurance has not passed.
    const moveTo = page.getByRole("form", { name: "Move to" });
    await moveTo.getByLabel("Next state").selectOption("Active");
    await moveTo.getByLabel("Reason").fill("Ready to work.");
    await moveTo.getByRole("button", { name: "Move" }).click();
    await expect(page.getByText("Every blocking onboarding item must pass")).toBeVisible();
    // The Producer verifies the item; the engaged party never verifies their own.
    await page.getByRole("button", { name: "Record verification" }).first().click();
    await expect(page.getByText("Passes", { exact: true }).first()).toBeVisible();
    await moveTo.getByLabel("Next state").selectOption("Active");
    await moveTo.getByLabel("Reason").fill("Onboarding complete.");
    await moveTo.getByRole("button", { name: "Move" }).click();
    await expect(page.getByText("Active").first()).toBeVisible();
    // A signing link for the Sent agreement, shown once.
    await page.getByLabel("Recipient email").fill("crew@example.com");
    await page.getByRole("button", { name: "Issue signing link" }).click();
    // The link shows in full when GATEWAY_SITE_URL names Gateway, as a path otherwise.
    await expect(page.getByText(/^(https?:\/\/[^/\s]+)?\/sign\/xdoc_/)).toBeVisible();
    await expect(page.getByText(/Access code: \d{6}/)).toBeVisible();
    await expectAccessible(page);
  });

  test("onboarding, pools, ratings, marketplace settings and the project Engagements tab", async ({
    page,
  }) => {
    await page.goto(`/${ORG}/opportunities/onboarding`);
    await expect(page.getByRole("heading", { level: 1, name: "Onboarding" })).toBeVisible();
    await expectAccessibleInBothThemes(page);

    await page.goto(`/${ORG}/opportunities/pools`);
    await expect(page.getByRole("heading", { level: 1, name: "Pools" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page.getByRole("link", { name: "Trusted Riggers" }).click();
    await expect(page.getByText("Pools are internal.")).toBeVisible();
    await expect(page.getByText("Demo Crew Member")).toBeVisible();
    await expectAccessibleInBothThemes(page);

    await page.goto(`/${ORG}/opportunities/ratings`);
    await expect(page.getByRole("heading", { level: 1, name: "Ratings" })).toBeVisible();
    await expectAccessibleInBothThemes(page);

    await page.goto(`/${ORG}/opportunities/marketplace-settings`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Marketplace settings" }),
    ).toBeVisible();
    await expect(page.getByText("No placement can be bought.")).toBeVisible();
    await expectAccessibleInBothThemes(page);

    await page.goto(`/${ORG}/opportunities/engagements?view=board`);
    await expect(page.getByRole("heading", { level: 1, name: "Engagements" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
  });

  test("the project Engagements tab lists the project's engagements for a project overseer", async ({
    page,
  }) => {
    await page.context().clearCookies();
    await signInAsProducer(page, "owner@example.com");
    await page.goto(`/${ORG}/p/NWS/engagements`);
    await expect(page.getByRole("heading", { level: 1, name: "Engagements" })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Demo Crew Member/ })).toBeVisible();
    await expectAccessibleInBothThemes(page);
  });

  test("a hidden posting shows the not-found page, never a forbidden one", async ({ page }) => {
    // The region streams behind its loading skeleton, so the status is already sent; the not-found page renders.
    await page.goto(`/${ORG}/opportunities/postings?id=0192f1e2-7c3a-7b4d-9e8f-000000000999`);
    await expect(page.getByText(NOT_FOUND_TITLE)).toBeVisible();
    await expectAccessible(page);
  });
});
