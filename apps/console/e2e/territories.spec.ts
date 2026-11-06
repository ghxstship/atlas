import { expect, test } from "@playwright/test";
import {
  expectAccessibleInBothThemes,
  newOperator,
  signInOperator,
  sql,
  uniqueId,
} from "./support";

/**
 * Where XOS is offered (ADR 0160): an Administrator opens and closes a territory with a reason and records an exception
 * for a signed contract, each on the console ledger. Support reads the same page and changes nothing.
 */

test("an Administrator opens a territory and records an exception, on the ledger", async ({
  page,
}) => {
  const id = uniqueId();
  const email = await newOperator("Administrator", "Ada Territory");
  await signInOperator(page, email, "/territories");
  const list = page.getByTestId("territories");
  const us = list.getByRole("row").filter({ hasText: "the United States" });
  const uk = list.getByRole("row").filter({ hasText: "the United Kingdom" });
  await expect(us.getByText("Open", { exact: true })).toBeVisible();
  await expect(uk.getByText("Closed", { exact: true })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // Opening one needs a reason, and it shows at once.
  const reason = `UK representative appointed, ${id}.`;
  await uk.getByLabel("Reason", { exact: true }).fill(reason);
  await uk.getByRole("button", { name: "Open this territory", exact: true }).click();
  await expect(uk.getByText("Open", { exact: true })).toBeVisible();
  await expect(uk.getByText(reason, { exact: false })).toBeVisible();
  try {
    const ledger = await sql<{ n: string }>(
      `select count(*)::text as n from app.platform_operator_actions where action = 'territory.opened' and reason = $1`,
      [reason],
    );
    expect(ledger[0]?.n).toBe("1");
  } finally {
    await uk.getByLabel("Reason", { exact: true }).fill(`Closed again, ${id}.`);
    await uk.getByRole("button", { name: "Close this territory", exact: true }).click();
    await expect(uk.getByText("Closed", { exact: true })).toBeVisible();
  }

  // An exception names a person, a country and a signed contract; a refused one keeps what was typed.
  const owner = `owner-${id}@example.test`;
  const form = page.getByTestId("territory-exception-form");
  await form.getByLabel("First Owner's email", { exact: true }).fill(owner);
  await form.getByLabel("Country", { exact: true }).selectOption("US");
  await form.getByLabel("Contract", { exact: true }).fill(`MSA-${id}`);
  await form.getByLabel("Date signed", { exact: true }).fill("2026-11-02");
  await form.getByLabel("Reason", { exact: true }).fill("Signed contract.");
  await form.getByRole("button", { name: "Record exception", exact: true }).click();
  await expect(
    form.getByText("XOS is already offered in that country", { exact: false }),
  ).toBeVisible();
  await expect(form.getByLabel("Contract", { exact: true })).toHaveValue(`MSA-${id}`);

  await form.getByLabel("Country", { exact: true }).selectOption("DE");
  await form.getByRole("button", { name: "Record exception", exact: true }).click();
  await expect(form.getByText("Exception recorded.", { exact: true })).toBeVisible();
  const exceptions = page.getByTestId("territory-exceptions");
  const row = exceptions.getByRole("row").filter({ hasText: owner });
  await expect(row.getByText(`MSA-${id}`, { exact: false })).toBeVisible();

  // Withdrawn, it allows nothing.
  await row.getByLabel("Reason", { exact: true }).fill("Contract fell through.");
  await row.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(row.getByText("Contract fell through.", { exact: false })).toBeVisible();
});

test("Support reads the territories and changes nothing", async ({ page }) => {
  const email = await newOperator("Support", "Sam Territory");
  await signInOperator(page, email, "/territories");
  await expect(page.getByTestId("territories")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open this territory", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByTestId("territory-exception-form")).toHaveCount(0);
  await expect(page.getByTestId("territory-form")).toHaveCount(0);
});
