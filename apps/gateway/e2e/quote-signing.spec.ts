import { expect as baseExpect, test } from "./engine-test";
import {
  PEOPLE,
  PROJECT,
  ROLE_ACCOUNTS,
  ROLE_PEOPLE,
  roleEngagement,
  suffix,
} from "./role-fixtures";
import { expectAccessible, signIn, sql } from "./support";

/**
 * B13 (RRR-237, S14.5-01, S4.4-12): a client accepts a quote. On a signing link, the access code opens the lines, total,
 * valid until and fingerprint, with the consent sentence before Accept quote; Download PDF posts the code in the form
 * body, never a URL; and accepting records the typed name and the link's email. Signed in, Sign on a Quote row opens a
 * confirmation with the total and valid-until date, and Home offers no one-click signature. Nothing internal shows.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

/** A budget with a client price and a sent quote for the engagement, as the Owner, through the RPCs. */
async function sentQuote(engagementId: string, name: string) {
  const [budget] = await sql<{ id: string }>(
    `insert into app.budgets (project_id, name, currency_code, default_markup_bp)
     values ($1, $2, 'USD', 2500) returning id`,
    [PROJECT, `${name} budget`],
    PEOPLE.owner,
  );
  const budgetId = budget?.id as string;
  await sql(
    `insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
     values ($1, 1, 'Stage deck', '5000.04.02', 2, 10000, 'X', 'Declared'),
            ($1, 2, 'Secret contingency', '5000.04.02', 1, 5000, 'X', 'Declared')`,
    [budgetId],
    PEOPLE.owner,
  );
  await sql(
    `update app.budget_lines set excluded_from_quote = true where budget_id = $1 and line_number = 2`,
    [budgetId],
  );
  const [quote] = await sql<{ id: string }>(
    `select app.create_quote($1, $2, $3) as id`,
    [budgetId, name, engagementId],
    PEOPLE.owner,
  );
  const [version] = await sql<{ id: string }>(
    `select id from app.quote_versions where quote_id = $1`,
    [quote?.id],
  );
  const versionId = version?.id as string;
  const [sent] = await sql<{ engagement_document_id: string }>(
    `select engagement_document_id from app.send_quote_version($1, 'Sent for signature.')`,
    [versionId],
    PEOPLE.owner,
  );
  return { versionId, documentId: sent?.engagement_document_id as string };
}

test("a client accepts a quote through its signing link and downloads the PDF", async ({
  page,
}) => {
  const name = `Link quote ${suffix()}`;
  const engagement = await roleEngagement({
    person: ROLE_PEOPLE.client,
    account: ROLE_ACCOUNTS.client,
    roleType: "Client",
  });
  const { versionId, documentId } = await sentQuote(engagement.id, name);
  const [link] = await sql<{ token: string; access_code: string }>(
    `select token, access_code from app.issue_engagement_document_token($1, 'typed@example.test')`,
    [documentId],
    PEOPLE.owner,
  );

  await page.goto(`/sign/${link?.token}`);
  await page.getByLabel("Access code").fill(link?.access_code as string);
  await page.getByRole("button", { name: "Open", exact: false }).click();
  await expect(page.getByRole("cell", { name: "Stage deck", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "$250.00", exact: true }).first()).toBeVisible();
  await expect(page.getByText("Secret contingency")).toHaveCount(0);
  await expect(
    page.getByText("By typing your name and choosing Accept quote, you consent", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("The organization countersigns next.")).toHaveCount(0);
  await expectAccessible(page);

  // The code travels in the form body; the PDF comes back without it in any URL.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download PDF", exact: true }).click(),
  ]);
  expect(download.url()).not.toContain(link?.access_code as string);
  expect(download.suggestedFilename()).toMatch(/^quote-.*\.pdf$/);

  await page.getByLabel("Type your full name to sign").fill("Cleo Typed");
  await page.getByRole("button", { name: "Accept quote", exact: true }).click();
  await expect(page.getByText("Accepted by Cleo Typed.")).toBeVisible();
  const [accepted] = await sql<{
    quote_version_state: string;
    accepted_name: string;
    accepted_by: string | null;
  }>(
    `select quote_version_state::text, accepted_name, accepted_by from app.quote_versions where id = $1`,
    [versionId],
  );
  expect(accepted).toEqual({
    quote_version_state: "Accepted",
    accepted_name: "Cleo Typed",
    accepted_by: null,
  });
});

test("signed in, a quote is signed after a confirmation, never from Home in one click", async ({
  page,
}) => {
  const name = `Signed in quote ${suffix()}`;
  const engagement = await roleEngagement({
    person: ROLE_PEOPLE.client,
    account: ROLE_ACCOUNTS.client,
    roleType: "Client",
  });
  const { versionId } = await sentQuote(engagement.id, name);

  await signIn(page, "client@example.com", "/home");
  const item = page
    .getByRole("listitem")
    .filter({ hasText: `Quote` })
    .filter({ hasText: name })
    .first();
  await expect(page.getByRole("link", { name: "Review quote", exact: true }).first()).toBeVisible();
  await expect(item.getByRole("button", { name: "Sign", exact: true })).toHaveCount(0);

  // Nor from the engagement's Overview, which links to the Documents tab instead.
  await page.goto(`/work/engagements/${engagement.key}`);
  const next = page.getByRole("listitem").filter({ hasText: name }).first();
  await expect(next.getByRole("link").first()).toBeVisible();
  await expect(next.getByRole("button", { name: "Sign", exact: true })).toHaveCount(0);

  await page.goto(`/work/engagements/${engagement.key}/documents`);
  const row = page.getByRole("listitem").filter({ hasText: name });
  await row.getByRole("button", { name: "Sign", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Accept this quote" });
  await expect(dialog.getByText("$250.00", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("you consent to using electronic records", { exact: false }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Accept quote", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => {
      const [v] = await sql<{ s: string; by: string | null }>(
        `select quote_version_state::text as s, accepted_by from app.quote_versions where id = $1`,
        [versionId],
      );
      return v?.s;
    })
    .toBe("Accepted");
});

test("the PDF route is POST only and refuses a cross-site post", async ({ request }) => {
  const token = `xdoc_${"0".repeat(64)}`;
  const get = await request.get(`/sign/${token}/quote`);
  expect(get.status()).toBe(405);
  const cross = await request.post(`/sign/${token}/quote`, {
    headers: { "sec-fetch-site": "cross-site" },
    form: { accessCode: "000000" },
  });
  expect(cross.status()).toBeGreaterThanOrEqual(403);
});
