import { expect as baseExpect, test } from "@playwright/test";
import { ATLAS_URL } from "./atlas";
import { externalAccountWithHistory } from "./role-fixtures";
import { DEMO_PASSWORD, expectAccessible, signIn, sql } from "./support";

/**
 * Journey 60 (Section 20.2): a vendor company with an external account subscribes and starts using
 * Atlas; its organization record, ratings and history carry over with no duplicate. The company's
 * Account Owner sees its history in Gateway, starts Atlas with the same company from the
 * organization step (app.subscribe_external_account, migration 1081), and the history is still the
 * company's afterwards, in Gateway and in the database.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("journey 60: a vendor company starts Atlas with its own record, history intact", async ({
  page,
  browser,
}) => {
  const company = await externalAccountWithHistory();

  // Gateway: the completed engagement with Demo Productions is the company's history.
  await signIn(page, company.email, "/work/engagements");
  await page.goto("/work/engagements?view=list");
  await expect(page.getByText("Demo Productions").first()).toBeVisible();

  // Atlas: with no org yet, the organization step offers the company itself.
  const context = await browser.newContext({ baseURL: ATLAS_URL, reducedMotion: "reduce" });
  const atlas = await context.newPage();
  await atlas.goto(`/auth/sign-in?next=${encodeURIComponent("/auth/organization")}`);
  await atlas.locator("#signin-email").fill(company.email);
  await atlas.locator("#signin-password").fill(DEMO_PASSWORD);
  await atlas.getByRole("button", { name: "Sign in with password" }).click();
  await atlas.waitForURL("**/auth/organization");
  const offer = atlas.getByRole("form", { name: `Use ${company.name} in Atlas` });
  await expect(offer).toBeVisible();
  await expectAccessible(atlas);

  // Without the terms it is refused, and the page says why.
  await offer.getByRole("button", { name: `Use ${company.name} in Atlas` }).click();
  await expect(offer.getByText("Accept the terms to start Atlas with this company.")).toBeVisible();
  await offer.getByRole("checkbox").check();
  await offer.getByRole("button", { name: `Use ${company.name} in Atlas` }).click();
  await atlas.waitForURL(`**/${company.slug}/home`);
  await expect(atlas.getByRole("button", { name: company.name }).first()).toBeVisible();
  await expectAccessible(atlas);
  await context.close();

  // One organization, now subscribed, still the counterparty the demo org's history names.
  const [state] = await sql<{ orgs: string; subscribed: string; cp: string; ratings: string }>(
    `select
       (select count(*) from app.organizations where name = $2)::text as orgs,
       (select count(*) from app.subscriptions where org_id = $1 and deleted_at is null)::text as subscribed,
       (select c.organization_id::text from app.engagements e join app.counterparties c on c.id = e.counterparty_id
         where e.id = $3) as cp,
       (select count(*) from app.ratings where engagement_id = $3)::text as ratings`,
    [company.accountId, company.name, company.engagementId],
  );
  expect(state).toEqual({ orgs: "1", subscribed: "1", cp: company.accountId, ratings: "1" });

  // Gateway still shows the same history to the company.
  await page.goto("/work/engagements?view=list");
  await expect(page.getByText("Demo Productions").first()).toBeVisible();
});
