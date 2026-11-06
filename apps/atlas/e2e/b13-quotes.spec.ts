import { createClient } from "@supabase/supabase-js";
import { expect as baseExpect, settle, test } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import {
  DEMO_ORG_ID,
  DEMO_PROJECT,
  localSql,
  newBudget,
  newLine,
  removeBudget,
} from "./b13-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * B13 (RRR-237, G-188, S14.5-01): the Producer prices a budget for a client, creates a quote, previews its client lines
 * with cost and margin marked internal, and sends it. The signing link and access code stay on screen after the Send
 * control has left, until the dialog closes. The client accepts through api_public.token_sign_document with an anon
 * client, since Atlas journeys run only the Atlas server; the quote is then Accepted without a reload, and locked.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 25_000 });

test("a quote is priced, sent, accepted through its link and locked", async ({ page }) => {
  const id = uniqueId();
  const budgetId = await newBudget(`Quote budget ${id}`, 2500);
  await newLine(budgetId, 1, "Stage deck", 10000);
  const internal = await newLine(budgetId, 2, "Contingency", 5000);
  await localSql(`update app.budget_lines set excluded_from_quote = true where id = $1`, [
    internal,
  ]);
  const [engagement] = await localSql<{ id: string }>(
    `insert into app.engagements (org_id, project_id, person_id, role_type, start_date)
     select $1, $2, p.id, 'Client', current_date from app.people p
     where p.id = '01920000-0000-7000-8000-000000000101' returning id`,
    [DEMO_ORG_ID, DEMO_PROJECT],
  );
  const engagementId = engagement?.id as string;
  try {
    await signInAs(page, "owner@example.com", DEMO_ORG);

    // The client column set shows the marked-up price.
    await page.goto(`/${DEMO_ORG}/finance/budgets?budget=${budgetId}&columns=client`);
    const grid = page.getByRole("grid");
    await expect(
      grid.getByRole("gridcell", { name: "$125.00", exact: true }).first(),
    ).toBeVisible();

    // New quote.
    await page.goto(`/${DEMO_ORG}/finance/quotes?project=NWS`);
    await settle(page);
    await expect(async () => {
      await page
        .getByRole("button", { name: /^New quote/ })
        .first()
        .click();
      await expect(page.getByRole("dialog", { name: "New quote" })).toBeVisible({ timeout: 5_000 });
    }).toPass();
    const sheet = page.getByRole("dialog", { name: "New quote" });
    await sheet
      .getByLabel("Budget", { exact: true })
      .selectOption({ label: `NWS · Quote budget ${id}` });
    await sheet.getByLabel("Title", { exact: true }).fill(`Main stage ${id}`);
    await sheet.getByLabel("Client engagement", { exact: true }).selectOption(engagementId);
    await sheet.getByRole("button", { name: "New quote", exact: true }).click();

    await expect
      .poll(
        async () =>
          (
            await localSql<{ id: string }>(`select id from app.quotes where budget_id = $1`, [
              budgetId,
            ])
          ).length,
      )
      .toBe(1);
    const [quote] = await localSql<{ id: string }>(
      `select id from app.quotes where budget_id = $1`,
      [budgetId],
    );
    const quoteId = quote?.id as string;

    // The Draft shows client lines, internal cost and margin, and never the excluded line.
    await page.goto(`/${DEMO_ORG}/finance/quotes?peek=${quoteId}&full=1`);
    await expect(page.getByText("Stage deck", { exact: true })).toBeVisible();
    await expect(page.getByText("Contingency", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Internal: never on the quote", { exact: false })).toBeVisible();
    await expectAccessible(page);

    // Send: the link and code stay until the dialog closes.
    await settle(page);
    await expect(async () => {
      await page.getByRole("button", { name: "Send quote", exact: true }).click();
      await expect(page.getByLabel("Recipient email")).toBeVisible({ timeout: 5_000 });
    }).toPass();
    await page.getByLabel("Recipient email").fill(`client-${id}@example.test`);
    await page.getByRole("dialog").getByRole("button", { name: "Send quote", exact: true }).click();
    const link = page.getByTestId("quote-link-url");
    await expect(link).toBeVisible();
    const url = (await link.textContent()) as string;
    const code = (await page.getByTestId("quote-link-code").textContent()) as string;
    // Sending does not refresh the page while the dialog is open, so the link stays through a settle.
    await settle(page);
    await expect(link).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send quote", exact: true })).toHaveCount(0);

    // The client accepts through the link.
    const token = url.split("/sign/")[1] as string;
    const anon = createClient(
      process.env["NEXT_PUBLIC_SUPABASE_URL"] as string,
      process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] as string,
    );
    const signed = await anon.schema("api_public" as never).rpc(
      "token_sign_document" as never,
      {
        p_token: token,
        p_access_code: code,
        p_signer_name: "Cleo Typed",
      } as never,
    );
    expect(signed.error).toBeNull();

    // The page is still open and was not reloaded: LiveList brings the acceptance (S11.7-10).
    await expect(
      page.getByText("This quote was accepted, so it can't change.", { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Cleo Typed", { exact: true })).toBeVisible();
    await expect(
      page.getByText(`Signing link with access code, sent to client-${id}@example.test`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "New version", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Withdraw", exact: true })).toHaveCount(0);
  } finally {
    await removeBudget(budgetId);
  }
});
