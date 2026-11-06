import { expect, test } from "@playwright/test";
import pg from "pg";
import { DEMO_ORG, signInAs } from "./a36-support";
import { uniqueId } from "./support";

/**
 * B10 (RRR-234, G-130, ADR 0149 decision 4): an agreement batch from Atlas. A template with the rate and the shift table is
 * written on Onboarding; on the project Engagements tab three people are chosen and previewed. Two have a shift and one has
 * none, so that one's table is missing and they cannot be created. The rest are created and sent. A reader without payroll
 * sees the text masked, with no hash and no PDF. The party's signing and declining are b10-party-steps.spec.ts in Gateway.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

const OWNER = "01920000-0000-7000-8000-000000000101";
const FIELD = "01920000-0000-7000-8000-000000000104";
const PRODUCER = "01920000-0000-7000-8000-000000000103";
const PROJECT = "01920000-0000-7000-8000-000000001001";
const CREW_ENGAGEMENT = "01920000-0000-7000-8000-000000228401";

/** Runs SQL on the local stack only, as the demo Owner: the engagements and shifts this journey starts from. */
async function sql<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url))
    throw new Error("Set E2E_DATABASE_URL to the local stack.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: OWNER, role: "authenticated" }),
    ]);
    const result = await client.query(text, params);
    await client.query("commit");
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

async function engagementOf(person: string): Promise<string> {
  await sql(
    `insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement,
       agreed_rate_minor, currency_code, start_date)
     select $1, $2::uuid, 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 90000, 'USD', '2027-06-01'
     where not exists (select 1 from app.engagements e where e.project_id = $1 and e.person_id = $2::uuid and e.deleted_at is null)`,
    [PROJECT, person],
  );
  const [row] = await sql<{ id: string }>(
    `select e.id from app.engagements e where e.project_id = $1 and e.person_id = $2 and e.deleted_at is null limit 1`,
    [PROJECT, person],
  );
  return row?.id as string;
}

/** A Published shift on a day of its own, so repeating the journey never overlaps. */
async function publishedShift(engagement: string): Promise<void> {
  const days = 40 + Math.floor(Math.random() * 300);
  const [shift] = await sql<{ id: string }>(
    `insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
     values ($1, $2, '5000.51.02', date_trunc('hour', now()) + make_interval(days => $3::int),
       date_trunc('hour', now()) + make_interval(days => $3::int, hours => 8), 'America/Los_Angeles')
     returning id`,
    [PROJECT, engagement, days],
  );
  await sql(`select app.publish_shifts(array[$1]::uuid[])`, [shift?.id]);
}

test("an agreement batch: template, preview, create, send, and the masked reader", async ({
  page,
  browser,
}) => {
  const id = uniqueId().slice(-6);
  const name = `Crew Agreement ${id}`;
  await publishedShift(CREW_ENGAGEMENT);
  await publishedShift(await engagementOf(FIELD));
  await engagementOf(PRODUCER);
  await signInAs(page, "owner@example.com", DEMO_ORG);

  await page.goto(`/${DEMO_ORG}/opportunities/onboarding?template=new`);
  const form = page.getByRole("form", { name: "Agreement template" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Document title").fill("Agreement for {{party.name}}");
  await form
    .getByLabel("Text", { exact: true })
    .fill("You earn {{engagement.rate}}.\n\nYour shifts:\n{{shifts.table}}");
  await form.getByRole("button", { name: "Save template" }).click();
  await expect(page.getByText(name).first()).toBeVisible();
  await expect(page.getByText("Uses the rate").first()).toBeVisible();

  await page.goto(`/${DEMO_ORG}/p/NWS/engagements`);
  await page.getByRole("link", { name: "Generate agreements" }).click();
  await page.waitForURL(/generate=1/);
  const generate = page.getByRole("form", { name: "Generate agreements" });
  await generate.getByLabel("Template").selectOption({ label: name });
  await generate.getByRole("combobox", { name: "People" }).click();
  for (const person of [/Demo Crew Member/, /Demo Field Lead/, /Demo Producer/]) {
    await page.getByRole("option", { name: person }).click();
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await generate.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("heading", { name: "Preview for 3 people" })).toBeVisible();

  // The merge really filled the rate and the shift table for the people who have them.
  const row = (person: string) => page.getByRole("listitem").filter({ hasText: person });
  await expect(row("Demo Crew Member").getByText("Ready", { exact: true })).toBeVisible();
  await expect(row("Demo Crew Member").getByText("You earn $950.00.")).toBeVisible();
  await expect(row("Demo Crew Member").getByText(/P[DS]T/)).toBeVisible();
  // No shift, so no table: this person is held back and the count says so.
  await expect(row("Demo Producer").getByText("Missing fields", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create 2 documents" }).click();
  await expect(row("Demo Crew Member").getByText("Created", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("2 documents sent.");

  await page.goto(`/${DEMO_ORG}/opportunities/onboarding`);
  await expect(page.getByText(new RegExp(`· ${name}`)).first()).toBeVisible();
  await expect(page.getByText("Sent: 2").first()).toBeVisible();

  // The Owner holds payroll: the record offers the PDF, and the file opens.
  const record = `/${DEMO_ORG}/p/NWS/engagements?id=${CREW_ENGAGEMENT}`;
  await page.goto(record);
  const documentRow = page.getByRole("listitem").filter({ hasText: "Agreement for Demo Crew" });
  const pdf = documentRow.getByRole("link", { name: /PDF/ }).first();
  const href = (await pdf.getAttribute("href")) as string;
  expect(href).toMatch(/\/documents\/engagement-document\/[0-9a-f-]{36}/);
  expect((await page.request.get(href)).status()).toBe(200);

  // A viewer reads engagements but not pay: the text is masked, with no PDF and no hash anywhere on the page.
  const other = await browser.newContext({ reducedMotion: "reduce" });
  const reader = await other.newPage();
  await signInAs(reader, "viewer@example.com", DEMO_ORG);
  await reader.goto(record);
  const masked = reader.getByRole("listitem").filter({ hasText: "Agreement for Demo Crew" });
  await expect(masked.getByText("This text holds a rate you cannot read.")).toBeVisible();
  await expect(masked.getByRole("link", { name: /PDF/ })).toHaveCount(0);
  expect(await reader.locator("main").innerText()).not.toMatch(/\b[0-9a-f]{64}\b/);
  expect((await reader.goto(href))?.status()).toBe(404);
  await other.close();
});
