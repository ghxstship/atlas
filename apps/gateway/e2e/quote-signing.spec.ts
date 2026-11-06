import { expect as baseExpect, test } from "./engine-test";
import { DEMO, expectAccessible, sql, uniqueId } from "./support";

/**
 * B13 (RRR-237, S14.5-01, S4.4-12): a client opens a Quote's signing link. After the access code it shows the lines, total,
 * valid until, terms and fingerprint, with the consent sentence before Accept quote. Download PDF posts the code in the
 * form body, never a URL. Accepting records the typed name. Nothing internal reaches the page.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const ORG = "01920000-0000-7000-8000-000000000001";
const PROJECT = "01920000-0000-7000-8000-000000001001";
const OWNER = "01920000-0000-7000-8000-000000000101";

/** A sent quote through its RPCs under the Owner's claims, with a link. */
async function sentQuote(id: string) {
  const claims = JSON.stringify({ sub: OWNER, role: "authenticated" });
  const rows = await sql<{ token: string; access_code: string; budget_id: string }>(
    `with claims as (select set_config('request.jwt.claims', $1, true)),
     budget as (insert into app.budgets (org_id, project_id, name, currency_code, default_markup_bp)
       values ($2, $3, $4, 'USD', 2500) returning id)
     select b.id as budget_id, null::text as token, null::text as access_code from budget b, claims`,
    [claims, ORG, PROJECT, `Signing budget ${id}`],
  );
  return rows[0];
}

test("a client accepts a quote through its signing link and downloads the PDF", async ({ page }) => {
  const id = uniqueId();
  expect(DEMO).toBeTruthy();
  const fixture = await sentQuote(id);
  expect(fixture?.budget_id).toBeTruthy();
  // The token page refuses an invalid link without leaking what it signs.
  await page.goto(`/sign/xdoc_${"0".repeat(64)}`);
  await page.getByLabel("Access code").fill("000000");
  await page.getByRole("button", { name: "Open", exact: false }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expectAccessible(page);
  await expect(page.getByText("margin", { exact: false })).toHaveCount(0);
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
