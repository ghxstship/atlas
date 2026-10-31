import { expect as baseExpect, settledGoto, test, type Page } from "./engine-test";
import { ORG, signIn } from "./operations-support";
import { ALL, AURORA_URL, post, projectId, SEEDED, setSwitches, textFile } from "./b15-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * B15 (RRR-239, parity gap G-59): an itinerary is read with Aurora into a Travel fulfillment's
 * segments through an intake batch, one metered request per file. The extraction switch must be
 * on; the traveler is always the person's pick; the kept segments are added in one step.
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

test("extraction: an itinerary becomes travel segments of a Travel fulfillment", async () => {
  const title = `Artist Travel ${uniqueId()}`;
  const fulfillment = await post(page, "/api/v1/fulfillments", {
    project_id: await projectId(page, "NWS"),
    fulfillment_kind: "Travel",
    title,
  });
  await page.goto(`/${ORG}/hospitality/fulfillments?peek=${String(fulfillment["id"])}`);
  await page.getByRole("button", { name: "Import itineraries with Aurora" }).click();
  const panel = page.getByRole("dialog", { name: "Import itineraries with Aurora" });
  await panel
    .getByLabel("Files")
    .setInputFiles(
      textFile(
        "trip.txt",
        "E-TICKET ITINERARY Issued 2031-05-01\nPassenger: Riley Ortega\nFlight GA 100 departs MIA 2031-06-01 08:15 arrives ORD 2031-06-01 10:20\n",
      ),
    );
  await expect(panel.getByTestId("intake-allowance")).toContainText("Uses 1 request");
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Read 1 file" }).click();
  await expect(panel.getByText("AI-generated")).toBeVisible();
  const row = panel.getByTestId("itinerary-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByText("Zone read from the place")).toBeVisible();
  // The traveler is never Aurora's choice: pick one of the project's people.
  const traveler = row.getByLabel("Traveler");
  await traveler.selectOption({ index: 1 });
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Add 1 segment" }).click();
  await expect(panel.getByText("1 segment added to this fulfillment.")).toBeVisible();
  await panel.getByRole("button", { name: "Close" }).last().click();
  await page.reload();
  await expect(page.getByText("GA 100", { exact: false }).first()).toBeVisible();
});
