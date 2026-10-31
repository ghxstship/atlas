import { expect as baseExpect, settle, settledGoto, test, type Page } from "./engine-test";
import { ORG, signIn } from "./operations-support";
import { ALL, AURORA_URL, SEEDED, setSwitches } from "./b15-support";
import { expectAccessible } from "./support";

/**
 * B15 (RRR-239, parity gap G-240): an event plan, brief, approval pack or waste plan is drafted with
 * Aurora from the project's own records, held to its outline with what the records lack marked as
 * gaps, and saved as a labeled project document. The drafting switch must be on.
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

test("drafting: a waste plan follows its outline and is saved to project documents", async () => {
  await page.goto(`/${ORG}/p/NWS/documents`);
  await settle(page);
  // The button discloses the four kinds. A click before hydration is lost (A71, A77), so it is
  // clicked again only while the list is still closed.
  const draft = page.getByRole("button", { name: "Draft with Aurora", exact: true });
  await expect(async () => {
    if ((await draft.getAttribute("aria-expanded")) !== "true") await draft.click();
    await expect(draft).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 });
  }).toPass();
  const kinds = page.getByRole("list", { name: "Document to draft" });
  await expect(kinds.getByRole("button")).toHaveCount(4);
  await kinds.getByRole("button", { name: "Waste plan" }).click();
  const panel = page.getByRole("dialog", { name: "Draft a waste plan with Aurora" });
  await expect(panel.getByRole("heading", { name: "What Aurora receives" })).toBeVisible();
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByText("AI-generated")).toBeVisible();
  await expect(panel.getByText("Aurora left gaps it could not fill")).toBeVisible();
  await expect(panel.getByText("Headings the draft lacks")).toHaveCount(0);
  await panel.getByRole("button", { name: "Save to project documents" }).click();
  await expect(panel.getByText("Saved to project documents.", { exact: false })).toBeVisible();
});
