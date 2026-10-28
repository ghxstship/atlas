import { workflowTargets } from "@xos/testing";
import {
  countInteractions,
  expectAcknowledged,
  expectWithin,
  watchFor,
} from "@xos/testing/playwright";
import { DEMO_ORG, signInAs } from "./a36-support";
import { expect as baseExpect, settle, test, type Page } from "./engine-test";
import { uniqueId } from "./support";

/**
 * A145 (Section 11.11, RRR-208): the measured targets of the Atlas workflow table, as timed journeys on the demo
 * tenant (seeds 0010, 0107, 0108 and 1030, project NWS):
 *   Projects and gates  a new project from a template in under 60 s; gate readiness loads in under 500 ms
 *   Work and records    a record created and fully classified in under 10 s, keyboard only
 *   Show                a called cue reaches a second device (another browser context) in under 500 ms
 * Spans under a second are measured inside the pages, from the input to the first frame that shows the result;
 * the longer ones by the runner's clock. Each measure is kept on the test as a `latency` annotation.
 */

test.use({ reducedMotion: "reduce" });
test.describe.configure({ timeout: 180_000 });
const expect = baseExpect.configure({ timeout: 20_000 });

const PROJECT = "NWS";
/** Demo Owner's person id (seed 0010). */
const DEMO_OWNER = "01920000-0000-7000-8000-000000000101";

/** Waits until the page settles and the shell answers keys, with focus on the page, not a field. */
async function ready(page: Page) {
  await settle(page);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  await page.locator("#content").focus();
}

/** A project key no other run has used: five letters (projects_key_format, migration 0301). */
function projectKey(): string {
  return Array.from({ length: 5 }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26)),
  ).join("");
}

test("projects and gates: a new project from a template in under 60 s", async ({ page }) => {
  await signInAs(page, "admin@example.com", DEMO_ORG);
  const key = projectKey();
  const started = Date.now();
  await page.goto(`/${DEMO_ORG}/projects/templates`);
  await page.getByRole("link", { name: /Weekend Festival/ }).click();
  const form = page.getByRole("form", { name: "Create a project from this template" });
  await form.getByLabel("Project key").fill(key);
  await form.getByLabel("Project name").fill(`Timed Weekend ${key}`);
  await form.getByLabel("Start date").fill("2027-08-14");
  await form.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByText(`Project ${key} created.`)).toBeVisible();
  expectWithin(
    "New project from a template",
    Date.now() - started,
    workflowTargets.projectFromTemplateMs,
  );
  // The project exists with the template's records.
  await page.goto(`/${DEMO_ORG}/p/${key}/overview`);
  await expect(page.getByText(`Timed Weekend ${key}`).first()).toBeVisible();
});

test("projects and gates: gate readiness loads in under 500 ms", async ({ page }) => {
  await signInAs(page, "owner@example.com", DEMO_ORG);
  // A first visit to each tab, as a person has opened the project before; then from Schedule to Overview.
  await page.goto(`/${DEMO_ORG}/p/${PROJECT}/overview`);
  await expect(page.getByRole("region", { name: "Gate readiness" })).toBeVisible();
  await page.goto(`/${DEMO_ORG}/p/${PROJECT}/schedule`);
  await settle(page);
  const tab = page.getByRole("navigation", { name: "Project tabs" }).getByRole("link", {
    name: "Overview",
    exact: true,
  });
  // A person's pointer reaches the tab before it presses, and the tab prefetches on the way (ProjectTabs).
  await tab.hover();
  await expectAcknowledged(
    page,
    "Gate readiness",
    () => tab.click(),
    { selector: 'section[aria-label="Gate readiness"] li' },
    workflowTargets.gateReadinessMs,
  );
  await expect(page).toHaveURL(new RegExp(`/p/${PROJECT}/overview`));
});

test("work and records: create and fully classify a record in under 10 s, keyboard only", async ({
  page,
}) => {
  const title = `Check the rigging ${uniqueId()}`;
  const interactions = countInteractions(page);
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/home`);
  await ready(page);
  const pointersBefore = interactions.pointers();

  const started = Date.now();
  await page.keyboard.press("c");
  const menu = page.getByRole("dialog", { name: "Create" });
  await expect(menu).toBeVisible();
  // A brisk typist's pace, not an instant paste: the line sets the kind, owner, category, scope and date.
  await page.keyboard.type(`${title} /task @me #rigging ~${PROJECT} tomorrow 9am`, { delay: 25 });
  await expect(menu.getByRole("option", { name: `Add ${title} as Task` })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  const elapsed = Date.now() - started;

  expectWithin("Create and classify by keyboard", elapsed, workflowTargets.keyboardCreateMs);
  expect(interactions.pointers() - pointersBefore, "pointer presses during the journey").toBe(0);
  // Fully classified: the record carries the kind, owner, category, project and date the line named.
  const main = page.locator("#content");
  await expect(main.getByText("Task", { exact: true }).first()).toBeVisible();
  await expect(main.getByRole("combobox", { name: "Owner" })).toHaveValue(DEMO_OWNER);
  await expect(
    main.getByRole("definition").filter({ hasText: "5000.51.02" }).first(),
  ).toBeVisible();
  await expect(
    main.getByRole("definition").filter({ hasText: "NWS · Northwind Summer Series" }).first(),
  ).toBeVisible();
  await expect(
    main
      .getByRole("definition")
      .filter({ hasText: /9:00\W?AM/ })
      .first(),
  ).toBeVisible();
});

/** Resolves once the page's Realtime channel reports its Postgres subscription ready. */
function liveSubscription(page: Page): Promise<void> {
  return new Promise((resolve) => {
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const text = String(payload);
        if (
          text.includes("Subscribed to PostgreSQL") ||
          (text.includes("phx_reply") && text.includes("postgres_changes") && text.includes('"ok"'))
        ) {
          resolve();
        }
      });
    });
  });
}

test("show: a called cue reaches another device in under 500 ms", async ({ page, browser }) => {
  const name = `Timed Running Order ${uniqueId()}`;
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/p/${PROJECT}/show?create=1`);
  const sheet = page.getByRole("dialog", { name: "New running order" });
  await sheet.getByLabel("Name").fill(name);
  await sheet.getByLabel("Show day").fill("2027-03-13");
  await sheet.getByRole("button", { name: "Create running order" }).click();
  await page.waitForURL(/peek=/);
  const runUrl = page.url();
  for (const label of ["House to Half", "Walk-in Music Out"]) {
    await page.getByLabel("Cue", { exact: true }).fill(label);
    await page.getByRole("button", { name: "Add cue" }).click();
    await expect(page.getByRole("list", { name: `Cues of ${name}` })).toContainText(label);
  }

  // A second device: the same person in another browser context, following the running order live.
  const device = await browser.newContext({
    storageState: await page.context().storageState(),
    reducedMotion: "reduce",
  });
  try {
    const follower = await device.newPage();
    const subscribed = liveSubscription(follower);
    await follower.goto(`${runUrl}&live=1`);
    await expect(
      follower.getByRole("status").filter({ hasText: "No cue called yet" }),
    ).toBeVisible();
    await subscribed;

    await page.getByRole("button", { name: "Run live" }).click();
    const call = page.getByRole("button", { name: "Call next cue" });
    await expect(call).toBeVisible();
    await settle(page);

    for (const cue of ["House to Half", "Walk-in Music Out"]) {
      const shown = { selector: '[role="status"]', text: `Current cue: ${cue}` };
      const onFollower = await watchFor(follower, shown, { afterInput: false });
      const onCaller = await watchFor(page, shown);
      await call.click();
      const caller = await onCaller();
      const seen = await onFollower();
      // From the stage manager's press to the cue on the other device: the call, Realtime and the reread.
      expectWithin(
        `Cue sync, ${cue}`,
        seen.seenAt - (caller.inputAt ?? caller.seenAt),
        workflowTargets.cueSyncMs,
      );
      await settle(page);
    }
  } finally {
    await device.close();
  }
});
