import { expect as baseExpect, settledGoto, test, type Page } from "./engine-test";
import { ORG, signIn } from "./operations-support";
import { ALL, AURORA_URL, post, projectId, SEEDED, setSwitches, textFile } from "./b15-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * B15 (RRR-239, parity gap G-225): the lines of a Proposed payable invoice are read with Aurora, with
 * a tie-out against the printed total recomputed on every edit; a difference must be acknowledged
 * before the lines are added, each with the budget line the person chose. The extraction switch
 * must be on.
 */
test.use({ baseURL: AURORA_URL, reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 60_000 });

let page: Page;

test.beforeAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(240_000);
  page = settledGoto(await (await browser.newContext({ reducedMotion: "reduce" })).newPage());
  await signIn(page, "owner@example.com");
  await setSwitches(page, ALL);
});

test.afterAll(async () => {
  await setSwitches(page, SEEDED).catch(() => undefined);
  await page.context().close();
});

test("extraction: invoice lines tie out against the printed total before they are added", async () => {
  const counterparties = await page.request.get("/api/v1/counterparties?limit=1");
  const counterparty = ((await counterparties.json()) as { data: { id: string }[] }).data[0];
  test.skip(!counterparty, "The demo seed has no counterparty.");
  const invoice = await post(page, "/api/v1/invoices", {
    project_id: await projectId(page, "NWS"),
    direction: "Payable",
    counterparty_id: counterparty?.id,
    invoice_number: `B15-${uniqueId()}`,
    currency_code: "USD",
  });
  await page.goto(`/${ORG}/finance/invoices?peek=${String(invoice["id"])}`);
  await page.getByRole("button", { name: "Read lines from a document" }).click();
  const panel = page.getByRole("dialog", { name: "Read invoice lines with Aurora" });
  await panel
    .getByLabel("File")
    .setInputFiles(
      textFile(
        "invoice.txt",
        "INVOICE\n2 x Stage deck rental @ $150.00\n1 x Delivery @ $50.00\nTotal $360.00 USD\n",
      ),
    );
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByText("AI-generated")).toBeVisible();
  await expect(panel.getByTestId("invoice-line-row")).toHaveCount(2);
  // 300 + 50 against a printed 360: a difference of $10.00 to acknowledge.
  await expect(panel.getByTestId("tie-out-status")).toContainText(
    "Difference from the printed total",
  );
  const add = panel.getByRole("button", { name: "Add 2 lines" });
  await expect(add).toBeDisabled();
  await expectAccessible(page);
  await panel.getByLabel("I checked the difference").check();
  await expect(add).toBeEnabled();
  await add.click();
  await expect(panel.getByText("2 lines added to the invoice.")).toBeVisible();
});
