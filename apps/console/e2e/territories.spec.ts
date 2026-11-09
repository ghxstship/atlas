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

test("an edit starts from what the territory holds, and a currency it gives up can come back", async ({
  page,
}) => {
  const id = uniqueId();
  const email = await newOperator("Administrator", "Eda Territory");
  await signInOperator(page, email, "/territories");
  const held = async () =>
    (
      await sql<{ name_es: string; currencies: string; countries: string }>(
        `select t.name_es,
           coalesce((select string_agg(c.currency_code, ',') from private.territory_currencies c where c.territory_code = t.code), '') as currencies,
           (select count(*)::text from private.territory_countries c where c.territory_code = t.code) as countries
         from private.territories t where t.code = 'EEA'`,
      )
    )[0];
  const before = await held();
  expect(before?.currencies).toBe("EUR");
  const form = page.getByTestId("territory-form");
  const reason = form.getByLabel("Reason", { exact: true });
  const save = form.getByRole("button", { name: "Save territory", exact: true });
  try {
    // Adding cannot land on a territory that exists, so an empty form cannot wipe its lists.
    await form.getByLabel("Code", { exact: true }).fill("EEA");
    await form.getByLabel("Name in English", { exact: true }).fill(`Anything ${id}`);
    await form.getByLabel("Name in Spanish", { exact: true }).fill(`Cualquiera ${id}`);
    await reason.fill("Adding by mistake.");
    await save.click();
    await expect(
      form.getByText("A territory already has that code", { exact: false }),
    ).toBeVisible();
    await expect(form.getByLabel("Name in English", { exact: true })).toHaveValue(`Anything ${id}`);
    expect(await held()).toEqual(before);

    // Edit starts from what it holds: a change to its name leaves the lists alone.
    const eea = page
      .getByTestId("territories")
      .getByRole("row")
      .filter({ hasText: "the European Economic Area" });
    await eea.getByRole("link", { name: "Edit EEA", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Edit EEA", exact: true })).toBeVisible();
    await expect(form.getByLabel("Code", { exact: true })).toHaveValue("EEA");
    await expect(form.getByLabel("Name in Spanish", { exact: true })).toHaveValue(
      before?.name_es ?? "",
    );
    const removeEur = form.getByRole("button", { name: "Remove EUR", exact: true });
    await expect(removeEur).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await form.getByLabel("Name in Spanish", { exact: true }).fill(`Espacio ${id}`);
    await reason.fill(`Fixing the Spanish name, ${id}.`);
    await save.click();
    await expect(form.getByText("Territory saved.", { exact: true })).toBeVisible();
    await expect.poll(held).toEqual({ ...before, name_es: `Espacio ${id}` });
    await expect(form.getByLabel("Name in Spanish", { exact: true })).toHaveValue(`Espacio ${id}`);
    await expect(reason).toHaveValue("");

    // Taken off, the euro leaves the territory but not the picker, which reads the price book.
    await removeEur.click();
    await reason.fill(`No currency for now, ${id}.`);
    await save.click();
    await expect.poll(async () => (await held())?.currencies).toBe("");
    await expect(removeEur).toHaveCount(0);
    await expect(reason).toHaveValue("");
    await form.getByLabel("Currencies", { exact: true }).click();
    await page.getByRole("option", { name: "EUR", exact: true }).click();
    await reason.fill(`The euro again, ${id}.`);
    await save.click();
    await expect.poll(async () => (await held())?.currencies).toBe("EUR");
    await expect((await held())?.countries).toBe(before?.countries);
  } finally {
    await sql(
      `update private.territories set name_es = $1, change_reason = 'Restored after a journey.' where code = 'EEA'`,
      [before?.name_es ?? ""],
    );
    await sql(
      `insert into private.territory_currencies (territory_code, currency_code, sort_order)
       values ('EEA', 'EUR', 10) on conflict do nothing`,
    );
  }
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
  await expect(page.getByRole("link", { name: "Edit EEA", exact: true })).toHaveCount(0);
});
