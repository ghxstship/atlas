import { expect as baseExpect, settledGoto, test, type Page } from "./engine-test";
import { ORG, signIn } from "./operations-support";
import { ALL, AURORA_URL, post, projectId, SEEDED, setSwitches, textFile } from "./b15-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * B15 (RRR-239, parity gap G-173; ADR 0154): a coordinator who reviews advance answers drafts a
 * recipient's answers with Aurora from a document the party sent, accepts one, and the answer is
 * recorded on the party's behalf with its provenance, so someone else reviews it. Sections the
 * source does not answer are listed, never invented. The drafting switch must be on.
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

test("drafting: advance answers drafted from a tour book are recorded for the party with their provenance", async () => {
  const project = await projectId(page, "NWS");
  const packet = await post(page, "/api/v1/advance-packets", {
    project_id: project,
    title: `B15 Advance ${uniqueId()}`,
  });
  const id = String(packet["id"]);
  await post(page, "/api/v1/advance-sections", {
    advance_packet_id: id,
    position: 1,
    title: "Load In Notes",
    prompt: "Trucks and timing.",
  });
  await post(page, "/api/v1/advance-sections", {
    advance_packet_id: id,
    position: 2,
    title: "Parking",
    prompt: "Vehicles.",
  });
  const people = await page.request.get(`/api/v1/projects/${project}/people`);
  const person = (
    (await people.json().catch(() => ({ data: [] }))) as { data?: { person_id: string }[] }
  ).data?.[0];
  test.skip(!person, "No project person to send the packet to.");
  await post(page, "/api/v1/advance-recipients", {
    advance_packet_id: id,
    person_id: person?.person_id,
  });
  await post(page, `/api/v1/advance-packets/${id}/send`, {});
  await page.goto(`/${ORG}/advancing/packets?peek=${id}`);
  await page.getByRole("button", { name: "Draft advance answers" }).first().click();
  const panel = page.getByRole("dialog", { name: "Draft advance answers with Aurora" });
  await panel
    .getByLabel("Or a document the party sent")
    .setInputFiles(
      textFile("tour-book.txt", "Two trucks arrive at the dock at 07:00.\nNothing else to add.\n"),
    );
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByText("AI-generated")).toBeVisible();
  await expect(panel.getByTestId("drafted-answer")).toHaveCount(1);
  await expect(panel.getByText("Sections the source does not answer")).toBeVisible();
  await expect(panel.getByText("Parking")).toBeVisible();
  await panel.getByRole("button", { name: "Accept" }).click();
  await expect(panel.getByText("Accepted")).toBeVisible();
  await panel.getByRole("button", { name: "Close" }).last().click();
  await page.reload();
  await expect(page.getByTestId("drafted-answer-note")).toContainText("tour-book.txt");
});
