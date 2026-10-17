import { expect as baseExpect, test } from "@playwright/test";
import { atlasAs, ORG } from "./atlas";
import {
  asPerson,
  changeOrderForClient,
  ROLE_ACCOUNTS,
  ROLE_PEOPLE,
  roleEngagement,
  sentDocument,
  suffix,
  transition,
} from "./role-fixtures";
import { DEMO, expectAccessible, expectAccessibleInBothThemes, signIn, sql } from "./support";

/**
 * Journey 46 (Section 20.2), client: the client signs the proposal the org sent, which opens the
 * engagement; approves a change order in Gateway that the Producer then opens in Atlas; reads the shared
 * run of show; and never reaches internal notes, margins or other parties' rates, on screen or
 * through the database.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("journey 46: the client approves a change order and reads the run of show, nothing internal", async ({
  page,
  browser,
}) => {
  const engagement = await roleEngagement({
    person: ROLE_PEOPLE.client,
    account: ROLE_ACCOUNTS.client,
    roleType: "Client",
  });
  const proposal = `Opening Night Proposal ${suffix()}`;
  await sentDocument(engagement.id, "Offer", proposal);

  // The signed proposal opens the engagement.
  await signIn(page, "client@example.com", `/work/engagements/${engagement.key}/documents`);
  const row = page.getByRole("listitem").filter({ hasText: proposal });
  await expect(row).toBeVisible();
  await expectAccessible(page);
  await row.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(row.getByText("Signed. The organization countersigns next.")).toBeVisible();
  await transition("engagement", engagement.id, "Onboarding", "Active", "Proposal signed.");

  const order = await changeOrderForClient(engagement.id);
  await page.goto(`/work/engagements/${engagement.key}/change-orders?view=list`);
  const co = page.getByRole("listitem").filter({ hasText: order.title });
  await expect(co).toBeVisible();
  await expect(co).toContainText("$6,400.00");
  await expect(page.getByText(order.internal)).toHaveCount(0);
  await expectAccessibleInBothThemes(page);
  const decide = co.getByRole("form", { name: order.title });
  await decide.getByLabel("Note to the organization").fill("Approved for opening night.");
  await decide.locator('button[type="submit"]').click();
  await expect(page.getByText("Decision sent.")).toBeVisible();

  await page.goto(`/work/engagements/${engagement.key}/approvals`);
  await expect(
    page.getByRole("listitem").filter({ hasText: "Please approve the VIP riser" }),
  ).toContainText("Approved");
  const [decision] = await sql<{ decision: string }>(
    `select decision::text from app.client_approval_requests where change_order_id = $1`,
    [order.id],
  );
  expect(decision?.decision).toBe("Approved");

  // The shared run of show, with its cues.
  await page.goto(`/work/engagements/${engagement.key}/run-of-show`);
  await expect(page.getByRole("heading", { name: /Opening Night Running Order/ })).toBeVisible();
  await expectAccessible(page);

  // Nothing internal reaches the client: not the change order's reason or budget link, not the
  // budget, not another party's rate.
  await expect(
    asPerson(ROLE_PEOPLE.client, `select budget_line_id from api_external.change_order_lines`),
  ).rejects.toThrow(/column "budget_line_id" does not exist/);
  const reach = await asPerson<{ notes: string; cos: string; lines: string }>(
    ROLE_PEOPLE.client,
    `select (select count(*) from app.comments where body = $1)::text as notes,
            (select count(*) from app.change_orders)::text as cos,
            (select count(*) from app.budget_lines)::text as lines`,
    [order.internal],
  );
  expect(reach[0]).toEqual({ notes: "0", cos: "0", lines: "0" });
  await expect(
    asPerson(ROLE_PEOPLE.client, `select agreed_rate_minor from app.engagements where id = $1`, [
      DEMO.crewEngagement,
    ]),
  ).rejects.toThrow(/permission denied/);

  // Atlas: the Producer opens the approved change order.
  const atlas = await atlasAs(browser, "producer@example.com");
  await atlas.page.goto(`/${ORG}/finance/change-orders?project=NWS&peek=${order.id}`);
  await expect(atlas.page.getByText(order.title).first()).toBeVisible();
  await expectAccessible(atlas.page);
  await atlas.context.close();
});
