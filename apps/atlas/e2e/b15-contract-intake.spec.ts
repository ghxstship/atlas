import { expect as baseExpect, settledGoto, test, type Page } from "./engine-test";
import { ORG, signIn } from "./operations-support";
import { ALL, AURORA_URL, SEEDED, setSwitches, textFile } from "./b15-support";
import { expectAccessible } from "./support";

/**
 * B15 (RRR-239, parity gap G-177): booking contracts and riders read with Aurora are sorted by act,
 * and an act with a party is booked as an Artist engagement at Onboarding with its rider, in one
 * step (ADR 0154). The extraction switch must be on. The fee column shows only to someone who may
 * see pay rates: the owner does here, and the fixture reads the fee only for them.
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

test("extraction: a contract and its rider are grouped by act and booked together", async () => {
  // The demo seed's Tidewater Catering is one of the org's counterparties, so the act has a party.
  await page.goto(`/${ORG}/p/NWS/engagements`);
  await page.getByRole("button", { name: "Import contracts and riders" }).click();
  const panel = page.getByRole("dialog", { name: "Import contracts and riders with Aurora" });
  await panel
    .getByLabel("Files")
    .setInputFiles([
      textFile(
        "tidewater-contract.txt",
        "PERFORMANCE AGREEMENT\nArtist: Tidewater Catering\nEngagement date: 2031-08-01\nGuarantee: USD 5,000.00\n",
      ),
      textFile(
        "tidewater-rider.txt",
        "TECHNICAL RIDER\nArtist: The Tidewater Catering\n2 x wedge monitors\n",
      ),
    ]);
  await expect(panel.getByLabel("What tidewater-rider.txt is")).toHaveValue("intake_rider");
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Read 2 files" }).click();
  await expect(panel.getByText("AI-generated")).toBeVisible();
  const group = panel.getByTestId("contract-group");
  await expect(group).toHaveCount(1);
  await expect(group.getByText("1 rider", { exact: false })).toBeVisible();
  await expect(group.getByText("Fee", { exact: false })).toBeVisible();
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Book 1 act" }).click();
  await expect(panel.getByText("1 act booked with 1 rider.")).toBeVisible();
});
