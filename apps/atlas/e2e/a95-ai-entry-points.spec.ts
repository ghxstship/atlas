import pg from "pg";
import { expect as baseExpect, settle, settledGoto, test, type Page } from "./engine-test";
import { ORG, signIn } from "./operations-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * A95 (RRR-140, finding A65-020, Section 4.7): the Aurora entry points in the browser, through the
 * real Atlas API, handlers, database, metering and confirmation steps. The model provider is never
 * called: these run against an Atlas started outside production with XOS_AI_FAKE=1 (E2E_AURORA_URL,
 * started by playwright.config.ts), whose fixture model answers deterministically
 * (apps/atlas/lib/aurora/fixture-entry.ts). Each entry point shows what Aurora receives before it
 * sends, shows the answer as an editable proposal labelled AI-generated, and writes nothing until the
 * person confirms; with a switch off its entry points are gone.
 *
 * The switches are set through the public API (`aiSettings.save`) and restored to the demo seed's
 * (assistant, extraction and summaries on) after the run. The features: plain_language, drafting,
 * summaries, extraction, mapping.
 */
test.use({
  baseURL: process.env["E2E_AURORA_URL"] ?? "http://127.0.0.1:3016",
  reducedMotion: "reduce",
});
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 30_000 });

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
      "Idempotency-Key": `a95-switches-${uniqueId()}`,
    },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** This month's metered Aurora requests for the org (app.ai_usage through aurora.status). */
async function used(page: Page): Promise<number> {
  const response = await page.request.get("/api/v1/aurora/status");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { used: number }).used;
}

async function suggestionState(page: Page, id: string) {
  const response = await page.request.get(`/api/v1/ai-suggestions/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as { suggestion_state: string; applied_id: string | null };
}

/** Only ever a local stack: the queue's rows are made the way a Compass device would leave them. */
async function database<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Only a local stack is changed.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function unknownScan(code: string): Promise<void> {
  await database((client) =>
    client.query(
      `insert into app.scan_intake (org_id, project_id, scanned_value, symbology, scan_mode, device_scanned_at)
       select p.org_id, p.id, $1, 'EAN-13', 'Inventory', now() - interval '1 hour'
         from app.projects p join app.organizations o on o.id = p.org_id
        where o.slug = $2 and p.project_key = 'NWS'`,
      [code, ORG],
    ),
  );
}

const INVOICE = [
  "INVOICE",
  "Bluewater Audio Rentals",
  "Invoice No. BW-20417",
  "Invoice date: 2026-09-02",
  "Payment due: 2026-10-02",
  "Total due: USD 18,450.00",
].join("\n");

const RECEIPT = [
  "HARBOR HARDWARE",
  "10/03/2026 14:22",
  "Gaffer tape 2in black x6",
  "TOTAL USD 89.94",
].join("\n");

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = settledGoto(await (await browser.newContext({ reducedMotion: "reduce" })).newPage());
  await signIn(page, "owner@example.com");
  await setSwitches(page, FEATURES);
});

test.afterAll(async () => {
  await setSwitches(page, SEEDED).catch(() => undefined);
  await page.context().close();
});

test("plain_language: a sentence becomes the page's own filters, shown and editable before they apply", async () => {
  await page.goto(`/${ORG}/finance/invoices?view=table`);
  const search = page.getByRole("search", { name: "Filter in plain language" });
  await expect(search).toBeVisible();
  const before = await used(page);

  await search.getByLabel("Filter in plain language").fill("overdue invoices from Bluewater");
  await search.getByRole("button", { name: "Build filter" }).click();
  const panel = page.getByRole("dialog", { name: "Filter invoices with Aurora" });
  await expect(panel.getByRole("heading", { name: "What Aurora receives" })).toBeVisible();
  await expect(panel.getByText("overdue invoices from Bluewater").first()).toBeVisible();
  await expect(
    panel.getByText("Restricted fields and medical records are never sent."),
  ).toBeVisible();
  await expectAccessible(page);

  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByText("AI-generated")).toBeVisible();
  const filters = panel.getByRole("list", { name: "Filters" });
  await expect(filters.getByLabel("Overdue")).toHaveValue("true");
  await expect(filters.getByLabel("Search")).toHaveValue("Bluewater");
  // The person edits a value before anything applies.
  await filters.getByLabel("Search").fill("Blue");
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Apply filter" }).click();

  await expect(page).toHaveURL(/overdue=true/);
  await expect(page).toHaveURL(/q=Blue(&|$)/);
  await expect(
    page.getByRole("status").filter({ hasText: "Filter applied: Overdue: Yes; Search: Blue." }),
  ).toBeAttached();
  // One model call, metered once; the preview of what is sent is not a model call.
  expect(await used(page)).toBe(before + 1);
});

test("plain_language: NO ANSWER, a used-up allowance and an unreachable API each say so plainly", async () => {
  await page.goto(`/${ORG}/finance/expenses`);
  const search = page.getByRole("search", { name: "Filter in plain language" });
  await search.getByLabel("Filter in plain language").fill("expenses on rainy days");
  await search.getByRole("button", { name: "Build filter" }).click();
  const panel = page.getByRole("dialog", { name: "Filter expenses with Aurora" });
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByText("No answer", { exact: true })).toBeVisible();
  await expect(panel.getByText(/filters only by the recorded words/)).toBeVisible();

  await page.route("**/api/v1/aurora/filter", (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/problem+json",
      body: JSON.stringify({
        title: "Refused",
        detail: "The plan allows 500 aurora_requests_per_month; this change needs 501.",
        rule: "plan_limit_exceeded",
      }),
    }),
  );
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByText(/Your org has used this month's Aurora requests/)).toBeVisible();
  await page.unroute("**/api/v1/aurora/filter");

  await page.route("**/api/v1/aurora/filter", (route) => route.abort("connectionrefused"));
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByText(/Aurora could not be reached/)).toBeVisible();
  await page.unroute("**/api/v1/aurora/filter");
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Close" }).first().click();
});

test("drafting: a change order description is drafted, edited, and written only by the form's save", async () => {
  const id = uniqueId();
  await page.goto(`/${ORG}/finance/change-orders?project=NWS&create=1`);
  const sheet = page.getByRole("dialog", { name: "New change order" });
  await sheet.getByLabel("Budget").selectOption({ index: 1 });
  await sheet.getByLabel("Title").fill(`Four more rigging points ${id}`);
  const before = await used(page);

  await sheet.getByRole("button", { name: "Draft with Aurora" }).click();
  const panel = page.getByRole("dialog", { name: "Draft a description with Aurora" });
  await expect(panel.getByLabel("What should the draft say?")).toHaveValue(
    `Four more rigging points ${id}`,
  );
  // The budget is read and scrubbed as the request would read it, before anything is sent.
  await expect(panel.getByText(/^Sent: /).first()).toBeVisible();
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByText("AI-generated")).toBeVisible();
  const draft = panel.getByLabel("Draft", { exact: true });
  await expect(draft).toHaveValue(new RegExp(`1\\. Four more rigging points ${id}`));
  await draft.fill(`${await draft.inputValue()}\nReviewed by the producer.`);
  await panel.getByRole("button", { name: "Use this draft" }).click();
  await expect(panel).toBeHidden();

  const reason = sheet.getByLabel("Why the change is needed");
  await expect(reason).toHaveValue(/Reviewed by the producer\./);
  expect(await used(page)).toBe(before + 1);
  await sheet.getByRole("button", { name: "New change order" }).click();
  await page.waitForURL(/peek=/);
});

test("drafting: an SOP and an advance packet section are drafted into their editors", async () => {
  await page.goto(`/${ORG}/knowledge/sops?create=1`);
  const drawer = page.getByRole("dialog", { name: "New SOP" });
  await drawer.getByRole("button", { name: "Draft with Aurora" }).click();
  const sop = page.getByRole("dialog", { name: "Draft an SOP with Aurora" });
  await sop.getByLabel("What should the draft say?").fill("Load-in for the main stage");
  await sop.getByRole("button", { name: "Send to Aurora" }).click();
  await sop.getByRole("button", { name: "Use this draft" }).click();
  await expect(drawer.getByLabel("Procedure")).toHaveValue(/Load-in for the main stage/);
  await expect(drawer.getByLabel("Title", { exact: true })).toHaveValue(
    "Load-in for the main stage",
  );

  const packets = await page.request.get("/api/v1/advance-packets?limit=50");
  const open = (
    (await packets.json()) as { data: { id: string; sent_at: string | null }[] }
  ).data.find((p) => p.sent_at === null);
  test.skip(!open, "The demo seed has no unsent advance packet.");
  await page.goto(`/${ORG}/advancing/packets?peek=${open?.id ?? ""}&full=1`);
  const sections = page.locator("#packet-sections");
  await sections.getByRole("button", { name: "Draft with Aurora" }).click();
  const section = page.getByRole("dialog", { name: "Draft a section with Aurora" });
  await expect(section.getByText(/^Sent: /).first()).toBeVisible();
  await section.getByLabel("What should the draft say?").fill("Ask for hospitality needs");
  await section.getByRole("button", { name: "Send to Aurora" }).click();
  await section.getByRole("button", { name: "Use this draft" }).click();
  await expect(sections.getByRole("textbox").last()).toHaveValue(/Ask for hospitality needs/);
});

test("summaries: gate readiness on project Overview and a record's activity, each point cited", async () => {
  await page.goto(`/${ORG}/p/NWS/overview`);
  await page.getByRole("button", { name: "Summarize" }).click();
  const panel = page.getByRole("dialog", { name: "Summarize with Aurora" });
  await expect(panel.getByRole("radio", { name: "This week" })).toBeChecked();
  await panel.getByRole("radio", { name: "Gate readiness" }).check();
  await expect(panel.getByText(/^Sent: gate_readiness$/)).toBeVisible();
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByText("AI-generated")).toBeVisible();
  await expect(panel.getByRole("heading", { name: /criteria have evidence/ })).toBeVisible();
  await expect(panel.getByLabel("Summary text")).toHaveValue(/criteria have evidence/);
  await panel.getByRole("button", { name: "Close" }).first().click();

  await page.goto(`/${ORG}/r/NWS-12`);
  await page.getByRole("button", { name: "Summarize" }).click();
  const record = page.getByRole("dialog", { name: "Summarize with Aurora" });
  await expect(record.getByText(/^NWS-12 /).first()).toBeVisible();
  await record.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(record.getByText("AI-generated")).toBeVisible();
  await expect(record.getByText("From").first()).toBeVisible();
  await expectAccessible(page);
});

test("extraction: an invoice fills the form, and the save applies Aurora's suggestion", async () => {
  await page.goto(`/${ORG}/finance/invoices?project=NWS&create=1`);
  const sheet = page.getByRole("dialog", { name: "New invoice" });
  await sheet.getByRole("button", { name: "Fill from an invoice" }).click();
  const panel = page.getByRole("dialog", { name: "Read an invoice with Aurora" });
  await panel.getByLabel("Document").setInputFiles({
    name: "bluewater-invoice.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(INVOICE),
  });
  await expect(panel.getByText(/bluewater-invoice\.txt, text\/plain/)).toBeVisible();
  await expect(panel.getByText("No records of your org are sent with the file.")).toBeVisible();
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByLabel("Invoice number")).toHaveValue("BW-20417");
  await expect(panel.getByText("96 percent confident.", { exact: false })).toBeVisible();
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Fill the form" }).click();

  await expect(sheet.getByLabel("Invoice number")).toHaveValue("BW-20417");
  await expect(sheet.getByLabel("Issued on")).toHaveValue("2026-09-02");
  await expect(sheet.getByLabel("Due on")).toHaveValue("2026-10-02");
  const suggestion = await sheet.locator('input[name="aiSuggestionId"]').first().inputValue();
  expect((await suggestionState(page, suggestion)).suggestion_state).toBe("Proposed");
  await sheet.getByLabel("Counterparty").selectOption({ index: 1 });
  await sheet.getByRole("button", { name: "New invoice" }).click();
  await page.waitForURL(/peek=/);
  const invoice = new URL(page.url()).searchParams.get("peek");
  await expect
    .poll(async () => suggestionState(page, suggestion))
    .toEqual(expect.objectContaining({ suggestion_state: "Applied", applied_id: invoice }));
});

test("extraction: a receipt fills the expense form; discarding a reading rejects it", async () => {
  await page.goto(`/${ORG}/finance/expenses?project=NWS&create=1`);
  const sheet = page.getByRole("dialog", { name: "New expense" });
  await sheet.getByRole("button", { name: "Fill from a receipt" }).click();
  const panel = page.getByRole("dialog", { name: "Read a receipt with Aurora" });
  await panel.getByLabel("Document").setInputFiles({
    name: "harbor-receipt.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(RECEIPT),
  });
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByLabel("Amount")).toHaveValue("89.94");
  await panel.getByRole("button", { name: "Fill the form" }).click();
  await expect(sheet.getByLabel("Description")).toHaveValue("Gaffer tape");
  await expect(sheet.getByLabel(/^Amount/)).toHaveValue("89.94");
  await expect(sheet.getByLabel("Incurred on")).toHaveValue("2026-10-03");

  await sheet.getByRole("button", { name: "Fill from a receipt" }).click();
  const again = page.getByRole("dialog", { name: "Read a receipt with Aurora" });
  await again.getByLabel("Document").setInputFiles({
    name: "harbor-receipt.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(RECEIPT),
  });
  await again.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(again.getByLabel("Amount")).toHaveValue("89.94");
  await again.getByRole("button", { name: "Discard" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Discarded. Nothing was filled or saved." }),
  ).toBeAttached();
});

test("mapping: Suggest binding binds an unknown scanned code after the person confirms", async () => {
  const code = `0${Date.now()}`.slice(0, 13);
  await unknownScan(code);
  await page.goto(`/${ORG}/credentials/scan-log`);
  const queue = page.locator("section", {
    has: page.getByRole("heading", { name: "Unresolved scans" }),
  });
  const row = queue.getByRole("listitem").filter({ hasText: code });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Suggest binding" }).click();
  const panel = page.getByRole("dialog", { name: `Bind code ${code}` });
  await panel.getByLabel("What the label says").fill("LED wall panel");
  await panel.getByRole("button", { name: "Find candidates" }).click();
  await expect(panel.getByText(/catalog elements? found/).first()).toBeAttached();
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByText(/Aurora suggests/)).toBeVisible();
  await expect(panel.getByLabel("Name in your catalog")).not.toHaveValue("");
  await panel.getByRole("button", { name: "Bind and resolve" }).click();
  await expect(panel).toBeHidden();
  await expect(queue.getByRole("listitem").filter({ hasText: code })).toHaveCount(0);
});

test("with the switches off, every entry point is gone", async () => {
  await setSwitches(page, []);
  try {
    const checks: [string, string][] = [
      [`/${ORG}/finance/invoices`, "Filter in plain language"],
      [`/${ORG}/finance/change-orders?project=NWS&create=1`, "Draft with Aurora"],
      [`/${ORG}/knowledge/sops?create=1`, "Draft with Aurora"],
      [`/${ORG}/p/NWS/overview`, "Summarize"],
      [`/${ORG}/r/NWS-12`, "Summarize"],
      [`/${ORG}/finance/invoices?project=NWS&create=1`, "Fill from an invoice"],
      [`/${ORG}/finance/expenses?project=NWS&create=1`, "Fill from a receipt"],
      [`/${ORG}/credentials/scan-log`, "Suggest binding"],
    ];
    for (const [path, name] of checks) {
      await page.goto(path);
      await settle(page);
      await expect(page.getByRole("button", { name }), path).toHaveCount(0);
      await expect(page.locator("[data-ai-entry]"), path).toHaveCount(0);
    }
    // The certificate reader (journey 36) follows the extraction switch too.
    await page.goto(`/${ORG}/vendors/insurance-certificates?create=1`);
    await settle(page);
    await expect(page.getByRole("region", { name: "Read a certificate with Aurora" })).toHaveCount(
      0,
    );
  } finally {
    await setSwitches(page, FEATURES);
  }
});
