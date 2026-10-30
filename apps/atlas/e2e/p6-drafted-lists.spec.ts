import { expect as baseExpect, settle, settledGoto, test, type Page } from "./engine-test";
import { ORG, signIn } from "./operations-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * P6 (RRR-220, parity gap G-83, Section 4.7): Aurora drafts a run of show into an empty running
 * order and a risk assessment into a project's empty risk list, through the real Atlas API,
 * handlers, database, metering and confirmation step. The model provider is never called: these run
 * against an Atlas started outside production with XOS_AI_FAKE=1 (E2E_AURORA_URL, started by
 * playwright.config.ts), whose fixture model drafts deterministically from the context
 * (apps/atlas/lib/aurora/fixture-entry.ts fixtureRunOfShow and fixtureRisks). Nothing is written
 * until the person adds the lines they keep, and only while the list is still empty.
 *
 * The drafting switch is turned on through the public API (`aiSettings.save`) and the demo seed's
 * switches (assistant, extraction and summaries) are restored after the run.
 */
test.use({
  baseURL: process.env["E2E_AURORA_URL"] ?? "http://127.0.0.1:3016",
  reducedMotion: "reduce",
});
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 60_000 });

type Feature = "assistant" | "plain_language" | "extraction" | "drafting" | "summaries" | "mapping";
const FEATURES: readonly Feature[] = [
  "assistant",
  "plain_language",
  "extraction",
  "drafting",
  "summaries",
  "mapping",
];
const SEEDED: readonly Feature[] = ["assistant", "extraction", "summaries"];

async function setSwitches(page: Page, on: readonly Feature[]) {
  const response = await page.request.post("/api/v1/ai-settings/save", {
    data: Object.fromEntries(FEATURES.map((f) => [`${f}_enabled`, on.includes(f)])),
    headers: {
      Origin: new URL(page.url()).origin,
      "Idempotency-Key": `p6-switches-${uniqueId()}`,
    },
    timeout: 120_000,
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function projectId(page: Page, key: string): Promise<string> {
  const response = await page.request.get("/api/v1/projects?limit=100&fields=id,project_key");
  const project = (
    (await response.json()) as { data: { id: string; project_key: string }[] }
  ).data.find((p) => p.project_key === key);
  test.skip(!project, `The demo seed has no project ${key}.`);
  return project?.id ?? "";
}

/** A new, empty running order on NWS, with a show day of its own for each run. */
async function newRun(page: Page, name: string): Promise<string> {
  const offset = Math.floor(Date.now() / 1000) % 3000;
  const day = new Date(Date.UTC(2031, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
  const created = await page.request.post("/api/v1/run-of-show", {
    headers: { "Idempotency-Key": `p6-run-${uniqueId()}`, Origin: new URL(page.url()).origin },
    data: { project_id: await projectId(page, "NWS"), name, show_date: day },
  });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

async function cues(page: Page, run: string) {
  const response = await page.request.get(
    `/api/v1/cues?filter[run_of_show_id][eq]=${run}&limit=100`,
  );
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { position: number; label: string }[] }).data.sort(
    (a, b) => a.position - b.position,
  );
}

let page: Page;

test.beforeAll(async ({ browser }, testInfo) => {
  // A development server compiles the sign-in and home routes on first use.
  testInfo.setTimeout(240_000);
  page = settledGoto(await (await browser.newContext({ reducedMotion: "reduce" })).newPage());
  await signIn(page, "owner@example.com");
  await setSwitches(page, FEATURES);
});

test.afterAll(async () => {
  await setSwitches(page, SEEDED).catch(() => undefined);
  await page.context().close();
});

test("drafting: a run of show fills an empty running order, flagged, edited and added in order", async () => {
  const name = `Drafted Night ${uniqueId()}`;
  const run = await newRun(page, name);
  await page.goto(`/${ORG}/show/run-of-show?peek=${run}`);
  const drawer = page.getByRole("dialog", { name: `NWS · ${name}` });
  await drawer.getByRole("button", { name: "Draft run of show with Aurora" }).click();
  const panel = page.getByRole("dialog", { name: "Draft a run of show with Aurora" });
  // The running order and its project are read and scrubbed as the draft reads them.
  await expect(panel.getByRole("heading", { name: "What Aurora receives" })).toBeVisible();
  await expect(panel.getByText(/^Sent: /).first()).toBeVisible();
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByText("AI-generated")).toBeVisible();
  await expect(
    panel.getByText("Nothing is saved until you add the lines you keep.", { exact: false }),
  ).toBeVisible();
  // The support act starts before doors end: the clash is flagged on its line.
  await expect(panel.getByText("Overlaps the cue before by 15 minutes.")).toBeVisible();
  await expect(panel.getByText("the walk-in music time")).toBeVisible();
  await expectAccessible(page);

  // Leave the untimed walk-in music out and rename doors; the flags follow every edit.
  await panel.getByLabel("Include line 5").uncheck();
  await panel.getByLabel("Label").first().fill("Doors Open");
  await panel.getByLabel("Length in Minutes").first().fill("45");
  await expect(panel.getByText("Overlaps the cue before by 15 minutes.")).toHaveCount(0);
  expect(await cues(page, run)).toEqual([]);
  await panel.getByRole("button", { name: "Add 4 cues" }).click();
  await expect(panel).toBeHidden();

  expect((await cues(page, run)).map((c) => [c.position, c.label])).toEqual([
    [1, "Doors Open"],
    [2, "Support Act"],
    [3, expect.any(String)],
    [4, "House Lights Up"],
  ]);
  await expect(drawer.getByText("Doors Open")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Draft run of show with Aurora" })).toHaveCount(
    0,
  );
});

test("drafting: a risk assessment fills a project's empty risk list for a qualified person to review", async () => {
  const project = await projectId(page, "NWG");
  const existing = await page.request.get(
    `/api/v1/records?filter[project_id][eq]=${project}&filter[record_kind][eq]=Risk&limit=5`,
  );
  const risks = ((await existing.json()) as { data: unknown[] }).data;
  test.skip(risks.length > 0, "NWG already has Risk records from an earlier attempt.");

  await page.goto(`/${ORG}/p/NWG/work?kind=Risk`);
  await page.getByRole("button", { name: "Draft risk assessment with Aurora" }).click();
  const panel = page.getByRole("dialog", { name: "Draft a risk assessment with Aurora" });
  await expect(panel.getByText("Categories", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByText("AI-generated")).toBeVisible();
  await expect(
    panel.getByText("Review each risk with a qualified person before you rely on it."),
  ).toBeVisible();
  // Keep three of the four: the sponsor signage risk is left out.
  await panel.getByLabel("Include line 4").uncheck();
  await panel.getByRole("button", { name: "Add 3 risks" }).click();
  await expect(panel).toBeHidden();

  const written = await page.request.get(
    `/api/v1/records?filter[project_id][eq]=${project}&filter[record_kind][eq]=Risk&limit=10`,
  );
  const rows = ((await written.json()) as { data: { title: string; record_state: string }[] }).data;
  expect(rows.map((r) => r.title).sort()).toEqual([
    "Afternoon Thunderstorm",
    "Changeover Overrun",
    "Crowd Surge at the Barricade",
  ]);
  expect(rows.every((r) => r.record_state === "Proposed")).toBe(true);
  await expect(page.getByText("Crowd Surge at the Barricade")).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft risk assessment with Aurora" })).toHaveCount(
    0,
  );
});

test("drafting: a cue added in another session before Add keeps the list as it is", async () => {
  const name = `Raced Night ${uniqueId()}`;
  const run = await newRun(page, name);
  await page.goto(`/${ORG}/show/run-of-show?peek=${run}`);
  const drawer = page.getByRole("dialog", { name: `NWS · ${name}` });
  await drawer.getByRole("button", { name: "Draft run of show with Aurora" }).click();
  const panel = page.getByRole("dialog", { name: "Draft a run of show with Aurora" });
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByText("AI-generated")).toBeVisible();

  const added = await page.request.post("/api/v1/cues", {
    headers: { "Idempotency-Key": `p6-cue-${uniqueId()}`, Origin: new URL(page.url()).origin },
    data: { run_of_show_id: run, position: 1, label: "Added by Hand" },
  });
  expect(added.status(), await added.text()).toBe(201);

  await panel.getByRole("button", { name: "Add 5 cues" }).click();
  await expect(
    panel.getByText("This list already has entries. Aurora only drafts into an empty list."),
  ).toBeVisible();
  expect((await cues(page, run)).map((c) => c.label)).toEqual(["Added by Hand"]);
  await panel.getByRole("button", { name: "Discard" }).click();
  await expect(panel).toBeHidden();
});

test("drafting: with the switch off, no list offers a draft", async () => {
  const name = `Switched Off ${uniqueId()}`;
  const run = await newRun(page, name);
  await setSwitches(
    page,
    FEATURES.filter((f) => f !== "drafting"),
  );
  try {
    await page.goto(`/${ORG}/show/run-of-show?peek=${run}`);
    await settle(page);
    const drawer = page.getByRole("dialog", { name: `NWS · ${name}` });
    await expect(drawer.getByText("Cues", { exact: true }).first()).toBeVisible();
    await expect(page.locator('[data-ai-entry="drafting"]')).toHaveCount(0);
    await page.goto(`/${ORG}/p/NWG/work?kind=Risk`);
    await settle(page);
    await expect(page.locator('[data-ai-entry="drafting"]')).toHaveCount(0);
  } finally {
    await setSwitches(page, FEATURES);
  }
});

test("drafting: the es-US locale shows the Spanish copy", async () => {
  const name = `Noche ${uniqueId()}`;
  const run = await newRun(page, name);
  await page.context().addCookies([{ name: "xos-locale", value: "es-US", url: page.url() }]);
  try {
    await page.goto(`/${ORG}/show/run-of-show?peek=${run}`);
    const drawer = page.getByRole("dialog", { name: `NWS · ${name}` });
    await drawer.getByRole("button", { name: "Redactar la orden de show con Aurora" }).click();
    const panel = page.getByRole("dialog", { name: "Redactar una orden de show con Aurora" });
    await expect(panel.getByLabel("¿Qué debe redactar Aurora?")).toBeVisible();
    await expectAccessible(page);
  } finally {
    await page.context().addCookies([{ name: "xos-locale", value: "en-US", url: page.url() }]);
  }
});
