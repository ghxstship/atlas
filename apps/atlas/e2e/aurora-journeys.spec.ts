import { expect, test } from "@playwright/test";
import { expectAccessibleInBothThemes, ORG, settled, signIn } from "./operations-support";
import { expectAccessible } from "./support";

/**
 * Journeys 35 and 36 (Section 20.2, Section 4.7) in the browser, through the real Atlas API,
 * handlers, database and confirmation step. The model provider is never called: these run against
 * an Atlas started outside production with XOS_AI_FAKE=1 (E2E_AURORA_URL, port 3016 by default,
 * started by playwright.config.ts), whose fixture model answers from recorded fixtures
 * (apps/atlas/lib/aurora/fixture-model.ts, finding A24-007). A production build cannot enable it.
 *
 *   35  the assistant lists the blocked permits in US-FL-MIAMI-DADE and cites them; asked the price
 *       of an unpriced element it answers NO ANSWER, never a price
 *   36  Aurora reads an insurance certificate; the person reviews each field's confidence and only
 *       their confirmation saves the certificate
 */
test.use({
  baseURL: process.env["E2E_AURORA_URL"] ?? "http://127.0.0.1:3016",
  reducedMotion: "reduce",
});
test.setTimeout(180_000);
expect.configure({ timeout: 30_000 });

const POLICY = "GL-7731-2027";
const CERTIFICATE = [
  "CERTIFICATE OF LIABILITY INSURANCE",
  "Insured: Demo Staging Supply",
  "INSURER A: Atlantic Mutual",
  `POLICY NUMBER: ${POLICY}`,
  "TYPE OF INSURANCE: COMMERCIAL GENERAL LIABILITY",
  "EACH OCCURRENCE $ 2,000,000",
  "POLICY EFFECTIVE 2026-10-01",
  "POLICY EXPIRATION 2027-09-30",
  "All amounts in USD",
].join("\n");

test("journey 35: blocked permits with the records cited, and NO ANSWER for an unpriced element", async ({
  page,
}) => {
  await signIn(page, "owner@example.com");
  await page.keyboard.press("ControlOrMeta+j");
  const panel = page.getByRole("dialog", { name: "Aurora" });
  await expect(panel).toBeVisible();
  const input = panel.getByLabel("Ask about your org's records");

  await input.fill("Which permits are blocked in US-FL-MIAMI-DADE?");
  await input.press("Enter");
  const permits = panel.getByRole("article", {
    name: "Which permits are blocked in US-FL-MIAMI-DADE?",
  });
  await expect(permits.getByText("AI-generated")).toBeVisible();
  await expect(
    permits.getByText(/1 blocked permit in US-FL-MIAMI-DADE: Special Event Permit/),
  ).toBeVisible();
  await expect(permits.getByRole("heading", { name: "Records used" })).toBeVisible();
  await expect(
    permits.getByRole("listitem").filter({ hasText: "Special Event Permit" }),
  ).toBeVisible();
  // Only the blocked one: the Proposed and Scheduled permits are not cited.
  await expect(permits.getByText("Noise variance / sound permit")).toHaveCount(0);

  await input.fill("What does stage floor plan drafting cost?");
  await input.press("Enter");
  const price = panel.getByRole("article", { name: "What does stage floor plan drafting cost?" });
  await expect(price.getByText("No answer")).toBeVisible();
  await expect(price.getByText(/the budget line is Unpriced/)).toBeVisible();
  await expect(price.getByText(/\$|USD/)).toHaveCount(0);
  await expectAccessible(page);
});

test("journey 36: an insurance certificate is read, reviewed with confidences, then confirmed", async ({
  page,
}) => {
  await signIn(page, "owner@example.com");
  await page.goto(`/${ORG}/vendors/insurance-certificates?create=1`);
  const reader = page.getByRole("region", { name: "Read a certificate with Aurora" });
  await expect(reader).toBeVisible();
  await settled(page);

  await reader.getByLabel("Insured vendor").selectOption({ label: "Demo Staging Supply" });
  await reader.getByLabel("Certificate file").setInputFiles({
    name: "coi-demo-staging.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(CERTIFICATE),
  });
  await reader.getByRole("button", { name: "Read with Aurora" }).click();

  // Every field with its confidence, marked as proposed by Aurora; nothing saved yet.
  const table = reader.getByRole("table", { name: "Fields Aurora read from the certificate" });
  await expect(table).toBeVisible();
  await expect(reader.getByText("Proposed by Aurora, an AI assistant")).toBeVisible();
  for (const [field, value, confidence] of [
    ["Insurer", "Atlantic Mutual", "97%"],
    ["Policy number", POLICY, "95%"],
    ["Coverage type", "General Liability", "92%"],
    ["Each occurrence limit", "200000000", "88%"],
    ["Currency", "USD", "81%"],
    ["Valid from", "2026-10-01", "90%"],
    ["Valid to", "2027-09-30", "90%"],
  ] as const) {
    const row = table.getByRole("row", { name: new RegExp(`^${field}`) });
    await expect(row).toContainText(value);
    await expect(row).toContainText(confidence);
  }
  await expectAccessibleInBothThemes(page);
  await page.waitForLoadState("networkidle");
  await page.goto(`/${ORG}/vendors/insurance-certificates?view=table`);
  // Leaving the review saved nothing.
  const before = await page.getByRole("row").filter({ hasText: "Atlantic Mutual" }).count();

  await page.waitForLoadState("networkidle");
  await page.goto(`/${ORG}/vendors/insurance-certificates?create=1`);
  await reader.getByLabel("Insured vendor").selectOption({ label: "Demo Staging Supply" });
  await reader.getByLabel("Certificate file").setInputFiles({
    name: "coi-demo-staging.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(CERTIFICATE),
  });
  await reader.getByRole("button", { name: "Read with Aurora" }).click();
  await expect(table).toBeVisible();
  await reader.getByRole("button", { name: "Confirm and save" }).click();
  await expect(reader.getByText("Certificate saved from the document.")).toBeVisible();

  await page.waitForLoadState("networkidle");
  await page.goto(`/${ORG}/vendors/insurance-certificates?view=table`);
  await expect(page.getByRole("row").filter({ hasText: "Atlantic Mutual" })).toHaveCount(
    before + 1,
  );
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "Atlantic Mutual" })
      .filter({ hasText: "Demo Staging Supply" })
      .first(),
  ).toBeVisible();
  await expectAccessible(page);
});
