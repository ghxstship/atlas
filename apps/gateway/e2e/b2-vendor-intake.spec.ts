import { cognitiveLoadProblems } from "./a11y/checks";
import { atlasAs, ORG } from "./atlas";
import { expect as baseExpect, settle, test } from "./engine-test";
import { asPerson, newSignIn, PEOPLE, PROJECT, requirements, suffix } from "./role-fixtures";
import { signIn, sql, uniqueId } from "./support";

/**
 * B2 vendor intake (RRR-226, ADR 0141; gap G-226): a reusable link, from the access code through sign-in, a new company
 * account, a W-9 shown as its last four, a payout reference with a bank number refused, the typed signature and a first
 * invoice draft in the org's currency, then Atlas approving it: the engagement in Onboarding with its items submitted but
 * not verified, and the intake's invoice once the engagement is Active. Each step keeps within gate 27.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const TIN = "123456789";

/** A Knowledge agreement on the project with a clean upload the link can pin. */
async function agreement(title: string): Promise<string> {
  const [document] = await sql<{ id: string }>(
    `insert into app.documents (org_id, project_id, title)
     select org_id, id, $2::text from app.projects where id = $1::uuid returning id`,
    [PROJECT, title],
    PEOPLE.owner,
  );
  const [upload] = await asPerson<{ attachment_version_id: string; object_name: string }>(
    PEOPLE.owner,
    `select u.attachment_version_id, u.object_name
       from app.begin_attachment_upload('app.documents', $1::uuid, 'msa.pdf', 'application/pdf', 2400) u`,
    [document?.id],
  );
  await sql(
    `insert into storage.objects (bucket_id, name, metadata) values ('attachments', $1, '{"size": 2400}')`,
    [upload?.object_name],
  );
  await asPerson(PEOPLE.owner, `select app.complete_attachment_upload($1::uuid, $2)`, [
    upload?.attachment_version_id,
    "cd".repeat(32),
  ]);
  await sql(`select app.record_attachment_scan($1::uuid, true)`, [upload?.attachment_version_id]);
  return document?.id as string;
}

test("a vendor goes from the code to an approved request and the intake's invoice", async ({
  page,
  browser,
}) => {
  const id = uniqueId();
  const mark = suffix();
  const email = `intake-${id}@example.com`;
  const person = await newSignIn(email, "Vera Vendor");
  const taxItem = `Intake W-9 ${mark}`;
  const payoutItem = `Intake remittance ${mark}`;
  const needed = await requirements("Vendor", [
    { name: taxItem, kind: "Tax Form" },
    { name: payoutItem, kind: "Payout Details" },
  ]);
  try {
    const document = await agreement(`Master agreement ${mark}`);
    const [link] = await asPerson<{ token: string; access_code: string }>(
      PEOPLE.owner,
      `select l.token, l.access_code from app.create_vendor_intake_link($1::uuid, $2, 'Vendor', '9000.50.02',
         'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-06-01', now() + interval '30 days', '2027-06-30',
         'AV Integrator', $3::uuid, 'Send us your details.', 'Team note', true, true, true, 50) l`,
      [PROJECT, `Audio vendors ${mark}`, document],
    );
    const token = link?.token as string;
    const code = link?.access_code as string;

    // The code, in the form body only; a wrong one is refused and counted.
    await page.goto(`/onboard/${token}`);
    await page.getByLabel("Access code").fill(code === "000000" ? "000001" : "000000");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByText("That code did not match.", { exact: false })).toBeVisible();
    await page.getByLabel("Access code").fill(code);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByRole("heading", { name: `Audio vendors ${mark}` })).toBeVisible();
    await expect(page.getByText("Send us your details.")).toBeVisible();
    await expect(page.getByText("Team note")).toHaveCount(0);

    // No account yet: the link goes no further than the intro.
    const go = page.getByRole("link", { name: "Continue", exact: true });
    await expect(go).toHaveAttribute("href", /\/auth\/sign-in\?next=%2Fonboard%2Fxvin_/);
    expect(await cognitiveLoadProblems(page)).toEqual([]);
    await signIn(page, email, `/onboard/${token}`);
    await settle(page);

    // Company: a new account.
    const heading = (name: string) => page.getByRole("heading", { name, exact: true });
    await expect(heading("Your company")).toBeVisible();
    await page.getByLabel("Or create a company account").fill(`Harbor Audio ${mark}`);
    expect(await cognitiveLoadProblems(page)).toEqual([]);
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Tax form: only the last four after entry.
    await expect(heading("Tax form")).toBeVisible();
    await page.getByLabel("Taxpayer identification number").fill(TIN);
    expect(await cognitiveLoadProblems(page)).toEqual([]);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(heading("Payout reference")).toBeVisible();
    expect(await page.content()).not.toContain(TIN);
    expect(await cognitiveLoadProblems(page)).toEqual([]);
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Payout: a bank number is refused and stores nothing; a reference with its prefix is taken.
    await expect(heading("Payout reference")).toBeVisible();
    await page.getByLabel("Reference", { exact: true }).fill("000123456789");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "looks like a bank account" }),
    ).toBeVisible();
    const [refused] = await sql<{ n: number }>(
      `select count(*)::int as n from app.payout_accounts where provider_account_reference = '000123456789'`,
    );
    expect(refused?.n).toBe(0);
    await page.getByLabel("Reference", { exact: true }).fill(`V-${mark}`);
    expect(await cognitiveLoadProblems(page)).toEqual([]);
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Agreement: the typed name applies to the pinned version.
    await expect(heading("Agreement")).toBeVisible();
    await page.getByLabel("Type your name to sign").fill("Vera Vendor");
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // First invoice: its header, then an add-line form above a read-only list.
    await expect(heading("First invoice")).toBeVisible();
    await page.getByLabel("Invoice number").fill(`BA-${mark}`);
    await expect(page.getByLabel("Currency")).toHaveValue("USD");
    expect(await page.getByLabel("Currency").locator("option").count()).toBeGreaterThan(20);
    expect(await cognitiveLoadProblems(page)).toEqual([]);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByLabel("Description", { exact: true }).fill("Audio day");
    await page.getByLabel("Unit price").fill("1,200.00");
    await page.getByRole("button", { name: "Add line", exact: true }).click();
    await expect(page.getByText("Audio day × 1 · $1,200.00")).toBeVisible();
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue("");
    expect(await cognitiveLoadProblems(page)).toEqual([]);
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Review holds the screen's one primary action.
    await expect(heading("Review and send")).toBeVisible();
    await expect(page.getByText("Signed by Vera Vendor", { exact: false })).toBeVisible();
    expect(await cognitiveLoadProblems(page)).toEqual([]);
    await page.getByRole("button", { name: "Send request", exact: true }).click();
    await expect(page.locator("[data-intake-sent]")).toContainText("Sent to");

    // Home shows the request, Waiting.
    await page.goto("/home");
    const card = page.locator('[data-intake-request-row="Pending"]').filter({
      hasText: `Audio vendors ${mark}`,
    });
    await expect(card.getByText("Waiting")).toBeVisible();

    // Atlas: the producer approves one request at a time; the dialog never shows the whole identifier.
    const atlas = await atlasAs(browser, "producer@example.com");
    await atlas.page.goto(`/${ORG}/p/NWS/engagements`);
    await expect(async () => {
      await atlas.page.getByRole("button", { name: "Intake requests", exact: true }).click();
      await expect(atlas.page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
    }).toPass();
    const dialog = atlas.page.getByRole("dialog");
    const request = dialog.locator("[data-intake-request]").filter({
      hasText: `Harbor Audio ${mark}`,
    });
    await expect(request).toBeVisible();
    await expect(request).not.toContainText(TIN);
    await request.getByRole("button", { name: "Decide", exact: true }).click();
    expect(await cognitiveLoadProblems(atlas.page)).toEqual([]);
    await request.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Approved", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).first().click();

    // The engagement is in Onboarding, its items submitted but not verified, the agreement Signed.
    const [made] = await sql<{ id: string; engagement_state: string; agreement: string }>(
      `select e.id, e.engagement_state::text,
              (select d.engagement_document_state::text from app.engagement_documents d
                where d.engagement_id = e.id and d.document_kind = 'Agreement') as agreement
         from app.vendor_intake_requests r join app.engagements e on e.id = r.engagement_id
        where r.requested_by = $1::uuid`,
      [person],
    );
    expect(made?.engagement_state).toBe("Onboarding");
    expect(made?.agreement).toBe("Signed");
    const items = await sql<{ item_kind: string; submitted: boolean; verified: boolean }>(
      `select i.item_kind::text, i.submitted_at is not null as submitted,
              exists (select 1 from app.onboarding_verifications v where v.onboarding_item_id = i.id) as verified
         from app.onboarding_items i
        where i.engagement_id = $1::uuid and i.item_kind in ('Tax Form', 'Payout Details')`,
      [made?.id],
    );
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      expect(item.submitted, item.item_kind).toBe(true);
      expect(item.verified, item.item_kind).toBe(false);
    }

    // A reviewer verifies each item, and only then does the engagement go Active.
    await atlas.page.goto(`/${ORG}/opportunities/engagements?id=${made?.id}`);
    for (const name of [taxItem, payoutItem]) {
      const item = atlas.page.getByRole("listitem").filter({ hasText: name });
      await item.getByRole("button", { name: "Record verification" }).click();
      await expect(item.getByText("Passes", { exact: true })).toBeVisible();
    }
    const moveTo = atlas.page.getByRole("form", { name: "Move to" });
    await moveTo.getByLabel("Next state").selectOption("Active");
    await moveTo.getByLabel("Reason").fill("Tax form and reference verified.");
    await moveTo.getByRole("button", { name: "Move" }).click();
    await expect
      .poll(async () => {
        const [state] = await sql<{ engagement_state: string }>(
          `select engagement_state::text from app.engagements where id = $1::uuid`,
          [made?.id],
        );
        return state?.engagement_state;
      })
      .toBe("Active");
    await atlas.context.close();

    // Home offers the intake's invoice once; it files in the draft's currency, Proposed.
    await page.goto("/home");
    const approved = page.locator('[data-intake-request-row="Approved"]').filter({
      hasText: `Audio vendors ${mark}`,
    });
    await approved.getByRole("button", { name: "Submit the invoice from your intake" }).click();
    await expect(
      approved.getByRole("button", { name: "Submit the invoice from your intake" }),
    ).toHaveCount(0);
    const [invoice] = await sql<{ invoice_state: string; currency_code: string }>(
      `select i.invoice_state::text, i.currency_code from app.vendor_intake_requests r
         join app.invoices i on i.id = r.invoice_id where r.requested_by = $1::uuid`,
      [person],
    );
    expect(invoice).toEqual({ invoice_state: "Proposed", currency_code: "USD" });
  } finally {
    await needed.retire();
  }
});

test("an intake address asks for a code and answers no-store", async ({ page }) => {
  const token = `xvin_${"0".repeat(64)}`;
  await page.goto(`/onboard/${token}`);
  await expect(page.getByLabel("Access code")).toBeVisible();
  const post = await page.request.post(`/onboard/${token}/open`, {
    form: { accessCode: "000000" },
    headers: { Origin: new URL(page.url()).origin },
    maxRedirects: 0,
  });
  expect(post.status()).toBe(303);
  expect(post.headers()["cache-control"]).toContain("no-store");
  expect(post.headers()["location"]).toContain("reason=intake_link_invalid");
  const get = await page.request.get(`/onboard/${token}/open`, { maxRedirects: 0 });
  expect(get.status()).toBe(303);
  expect((await page.request.get("/onboard/nope")).status()).toBe(404);
});
