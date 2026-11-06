import pg from "pg";
import { expect as baseExpect, settle, settledGoto, test, type Page } from "./engine-test";
import { ORG, signIn } from "./operations-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * B15 (RRR-239; ADR 0154): the Aurora intakes through the fixture model of lib/aurora/fixture-intake.ts,
 * on an Atlas started outside production with XOS_AI_FAKE=1 (E2E_AURORA_URL). Itineraries to segments, a
 * contract and rider to a booking, invoice lines with a residual, an accepted answer that a second person
 * reviews, and a governance draft saved into its Document record. Each journey makes its own records.
 */
const AURORA_URL = process.env["E2E_AURORA_URL"] ?? "http://127.0.0.1:3016";
test.use({ baseURL: AURORA_URL, reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 60_000 });

/** Reads and seeds as postgres, against the local stack only (E2E_DATABASE_URL). */
async function sql<T extends object>(text: string, values: readonly unknown[] = []): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Only a local stack is changed.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(text, [...values])).rows as T[];
  } finally {
    await client.end();
  }
}

const FEATURES = ["assistant", "plain_language", "extraction", "drafting", "summaries", "mapping"];
const SEEDED = ["assistant", "extraction", "summaries"];

let page: Page;
let project = "";
let projectKey = "";

const post = async (path: string, data: unknown) => {
  const response = await page.request.post(path, {
    data,
    headers: { Origin: new URL(page.url()).origin, "Idempotency-Key": `b15-${uniqueId()}` },
  });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return (await response.json()) as Record<string, unknown>;
};

const switches = (on: readonly string[]) =>
  post(
    "/api/v1/ai-settings/save",
    Object.fromEntries(FEATURES.map((f) => [`${f}_enabled`, on.includes(f)])),
  );

const textFile = (name: string, text: string) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(text, "utf8"),
});

test.beforeAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(240_000);
  page = settledGoto(await (await browser.newContext({ reducedMotion: "reduce" })).newPage());
  await signIn(page, "owner@example.com");
  await switches(FEATURES);
  const response = await page.request.get("/api/v1/projects?limit=100&fields=id,project_key");
  const row = (
    (await response.json()) as { data: { id: string; project_key: string }[] }
  ).data.find((p) => p.project_key === "NWS");
  project = row?.id ?? "";
  projectKey = row?.project_key ?? "";
  expect(project).not.toBe("");
});

test.afterAll(async () => {
  await switches(SEEDED).catch(() => undefined);
  await page.context().close();
});

test("itineraries: a confirmation with two passengers and a leg becomes segments after the person maps them", async () => {
  const fulfillment = await post("/api/v1/fulfillments", {
    project_id: project,
    fulfillment_kind: "Travel",
    title: `B15 Travel ${uniqueId()}`,
  });
  // A far-future departure unique to this run, so a retry never meets its own segment.
  const day = 10 + (Date.now() % 18);
  // The peek is addressed by the display key, not by the id.
  await page.goto(
    `/${ORG}/hospitality/fulfillments?peek=NWS-${String(fulfillment["fulfillment_number"])}`,
  );
  await settle(page);
  await page.getByRole("button", { name: "Read Itineraries", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Read Itineraries", exact: true });
  await panel
    .getByLabel("Files")
    .setInputFiles(
      textFile(
        "trip.txt",
        `Passenger: Dana Kim\nFlight GA ${day} Mar ${day} 2029 08:15 MIA to ORD Mar ${day} 2029 10:30\n`,
      ),
    );
  await expect(panel.getByTestId("intake-allowance")).toContainText("This uses 1");
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByRole("grid", { name: "Lines" })).toBeVisible();
  await expect(panel.getByText("AI-generated")).toBeVisible();
  await expect(panel.getByTestId("itinerary-row")).toHaveCount(1);
  // Nothing is ready until the traveler and both zones are the person's.
  await expect(panel.getByRole("button", { name: "Add 1 Segment" })).toBeDisabled();
  const printed = panel.getByLabel("Printed as Dana Kim", { exact: true });
  const options = await printed.locator("option").allTextContents();
  await printed.selectOption({ label: options.find((o) => o !== "Choose") ?? "" });
  for (const box of await panel.getByRole("checkbox", { name: "Confirmed", exact: true }).all()) {
    await box.check();
  }
  await panel.getByRole("button", { name: "Add 1 Segment" }).click();
  await expect(panel.getByText("Added 1 segment.")).toBeVisible();
  const rows = await sql<{ n: string }>(
    "select count(*) as n from app.travel_segments where project_id = $1 and service_identifier = $2 and deleted_at is null",
    [project, `GA ${day}`],
  );
  expect(Number(rows[0]?.n)).toBe(1);
});

test("contracts: a contract and a rider of one act book one engagement, and a reload resumes the review", async () => {
  const act = `Owls ${uniqueId()}`;
  // The act's party exists, so the review preselects it on the one exact match.
  await sql(
    `with me as (
       select set_config('request.jwt.claims', json_build_object('sub', u.id, 'role', 'authenticated')::text, true)
       from auth.users u where u.email = 'owner@example.com')
     select app.create_counterparty((select org_id from app.projects where id = $1), $2, null, null) from me`,
    [project, act],
  );
  await page.goto(`/${ORG}/p/${projectKey}/engagements`);
  await settle(page);
  await page.getByRole("button", { name: "Read Contracts and Riders", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Read Contracts and Riders", exact: true });
  await panel
    .getByLabel("Files")
    .setInputFiles([
      textFile(
        "agreement.txt",
        `ARTIST BOOKING AGREEMENT\nArtist: ${act}\nPerformance date: 2029-06-05\nGuarantee: USD 7,500.00\n`,
      ),
      textFile("rider.txt", `TECHNICAL RIDER\nArtist: ${act}\n`),
    ]);
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByTestId("contract-group").filter({ hasText: act })).toHaveCount(1);
  await expect(panel.getByTestId("printed-fee").first()).toContainText("7,500");
  // A reload loses the bytes and resumes the review from the open suggestions, without a model call.
  await page.reload();
  await settle(page);
  await page.getByRole("button", { name: "Read Contracts and Riders", exact: true }).click();
  const group = panel.getByTestId("contract-group").filter({ hasText: act });
  await expect(group).toHaveCount(1);
  const terms = panel.getByLabel("Terms", { exact: true });
  const labels = await terms.locator("option").allTextContents();
  await terms.selectOption({ label: labels.find((l) => l.includes("Day Rate")) ?? "" });
  await expect(
    panel.getByText("This fee is a total. Enter the rate per unit.").first(),
  ).toBeVisible();
  // Preselected on the one exact match of the act's name, and nothing else.
  await expect(group.getByLabel("Party", { exact: true }).locator("option:checked")).toHaveText(act);
  for (const other of await panel.getByTestId("contract-group").all()) {
    if (!(await other.textContent())?.includes(act)) {
      await other.getByRole("checkbox").first().uncheck();
    }
  }
  await panel.getByRole("button", { name: "Add 1 Booking" }).click();
  await expect(panel.getByTestId("contract-added")).toContainText("Added 1 booking.");
  // The resumed review has lost the file, so it offers Attach File on the document.
  await expect(panel.getByText("Attach File").first()).toBeVisible();
});

test("invoices: a printed total and its lines show a residual, which warns and blocks nothing", async () => {
  const number = `B15-${uniqueId()}`;
  await page.goto(`/${ORG}/finance/invoices?project=NWS&create=1`);
  await settle(page);
  const sheet = page.getByRole("dialog", { name: "New invoice" });
  await sheet.getByRole("button", { name: "Fill from an invoice" }).click();
  const panel = page.getByRole("dialog", { name: "Read an invoice with Aurora" });
  await panel
    .locator('input[type="file"]')
    .setInputFiles(
      textFile(
        "bill.txt",
        `Invoice ${number}\nCurrency: USD\nLine: 2 x Wedge monitor rental @ 450.00\nTax 80.00\nTotal 1,080.00\n`,
      ),
    );
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await panel.getByRole("button", { name: "Fill the form" }).click();
  await expect(sheet.getByLabel("Invoice number", { exact: true })).toHaveValue(number);
  await sheet.getByLabel("Counterparty").selectOption({ index: 1 });
  await sheet.getByRole("button", { name: "New invoice" }).click();
  await page.waitForURL(/peek=/);
  await settle(page);
  await page.getByRole("button", { name: "Review Lines from the Document", exact: true }).click();
  const lines = page.getByRole("dialog", { name: "Review Lines from the Document", exact: true });
  await expect(lines.getByTestId("invoice-line-row")).toHaveCount(2);
  await expect(lines.getByTestId("invoice-tie-out")).toContainText("Difference $0.00");
  // Unchecking the tax leaves a residual, which asks for a check before adding.
  await lines.getByRole("checkbox", { name: "Keep Tax", exact: true }).uncheck();
  await expect(lines.getByTestId("invoice-tie-out")).toContainText("Difference $80.00");
  await expect(lines.getByRole("button", { name: "Add Lines", exact: true })).toBeDisabled();
  await lines.getByRole("checkbox", { name: "I checked the difference", exact: true }).check();
  await lines.getByRole("button", { name: "Add Lines", exact: true }).click();
  await expect(lines.getByText("Added 1 line.")).toBeVisible();
  await lines.getByRole("button", { name: "Close" }).last().click();
  await page.reload();
  await settle(page);
  await expect(page.getByTestId("invoice-residual")).toContainText("$80.00");
});

test("advance answers: an answer from inbox mail is accepted, and a second person reviews it", async () => {
  const packet = await post("/api/v1/advance-packets", {
    project_id: project,
    title: `B15 Advance ${uniqueId()}`,
  });
  const id = String(packet["id"]);
  const section = await post("/api/v1/advance-sections", {
    advance_packet_id: id,
    position: 1,
    title: "Hospitality",
    prompt: "Needs.",
  });
  await post("/api/v1/advance-sections", {
    advance_packet_id: id,
    position: 2,
    title: "Parking",
    prompt: "Vehicles.",
  });
  const [recipient] = await sql<{ person_id: string }>(
    "select m.person_id from app.memberships m where m.org_id = (select org_id from app.projects where id = $1) and m.deleted_at is null limit 1",
    [project],
  );
  await post("/api/v1/advance-recipients", {
    advance_packet_id: id,
    person_id: recipient?.person_id,
  });
  await post(`/api/v1/advance-packets/${id}/send`, {});
  // The mail arrives through the inbound function's own RPC, seeded by service role.
  const [address] = await sql<{ local_part: string }>(
    "select local_part from app.inbound_addresses where project_id = $1 and disabled_at is null limit 1",
    [project],
  );
  let local = address?.local_part;
  if (!local) {
    const [made] = await sql<{ local_part: string }>(
      "insert into app.inbound_addresses (org_id, project_id, local_part) select org_id, id, $2 from app.projects where id = $1 returning local_part",
      [project, `b15-${uniqueId().toLowerCase()}`],
    );
    local = made?.local_part;
  }
  await sql(
    "select app.receive_inbound_email($1, 'advance@example.com', 'Our advance', $2, true, $3, 'raw/b15.eml')",
    [local, `<${uniqueId()}@example.com>`, "Hospitality: two cases of water.\nThanks."],
  );
  await page.goto(`/${ORG}/advancing/packets?peek=${id}`);
  await settle(page);
  await page
    .getByRole("button", { name: "Draft Answers from a Reply", exact: true })
    .first()
    .click();
  const panel = page.getByRole("dialog").filter({ hasText: "Draft Answers for" });
  await expect(panel.getByText("advance@example.com").first()).toBeVisible();
  await expectAccessible(page);
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await expect(panel.getByTestId("advance-answer-card")).toHaveCount(1);
  await expect(panel.getByText("Someone else reviews what you accept.")).toBeVisible();
  await expect(panel.getByText("Parking")).toBeVisible();
  await panel.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(panel.getByText("Recorded", { exact: true })).toBeVisible();
  const [answer] = await sql<{ id: string; created_by: string }>(
    "select id, created_by from app.advance_submissions where advance_section_id = $1",
    [String(section["id"])],
  );
  expect(answer?.id).toBeTruthy();
  await panel.getByRole("button", { name: "Close" }).last().click();
  await page.reload();
  await settle(page);
  await expect(page.getByTestId("answer-source").first()).toContainText(
    "Drafted by Aurora, accepted by",
  );
  await expect(page.getByTestId("answer-source").first()).toContainText("two cases of water");
});

test("governance: a waste plan draft fills the Document record's editor, and Save is the write", async () => {
  const title = `B15 Plan ${uniqueId()}`;
  const record = await post("/api/v1/records", {
    project_id: project,
    record_kind: "Document",
    record_subtype: "Plan",
    title,
  });
  await page.goto(`/${ORG}/r/${projectKey}-${String(record["record_number"])}`);
  await settle(page);
  await page.getByRole("button", { name: "Draft with Aurora", exact: true }).click();
  const panel = page
    .getByRole("dialog")
    .filter({ has: page.getByLabel("What should the draft say?", { exact: true }) });
  await panel.getByLabel("Draft", { exact: true }).selectOption("waste_plan");
  await panel
    .getByLabel("What should the draft say?", { exact: true })
    .fill("Draft the waste plan.");
  await panel.getByRole("button", { name: "Send to Aurora" }).click();
  await panel.getByRole("button", { name: "Use this draft" }).click();
  await expect(page.locator('textarea[name="body"]')).toHaveValue(/Unmeasured/);
  const before = await sql<{ body: string | null }>(
    "select body from app.record_document where record_id = $1",
    [String(record["id"])],
  );
  expect(before[0]?.body ?? null).toBeNull();
  await page
    .locator('form:has(textarea[name="body"])')
    .getByRole("button", { name: "Save" })
    .click();
  await expect
    .poll(
      async () =>
        (
          await sql<{ body: string | null }>(
            "select body from app.record_document where record_id = $1",
            [String(record["id"])],
          )
        )[0]?.body ?? "",
    )
    .toContain("Unmeasured");
});
