import { expect, settle, test } from "./engine-test";
import { expectAccessible, reloadSettled, signIn, sql, uniqueId } from "./support";

/**
 * The United States launch reaches Gateway's company accounts (ADR 0160): an organization started by whoever signs in asks
 * its country, says where XOS is offered, creates nothing outside an offered territory, keeps what was typed, and stands
 * in the console's review list only when nobody stated a country.
 */
test.use({ reducedMotion: "reduce" });

test("a company outside an offered territory gets no account, and the form says why", async ({
  page,
}) => {
  const id = uniqueId();
  await signIn(page, "crew@example.com", "/settings/organizations");
  await settle(page);
  await expect(
    page.getByText("XOS is offered to organizations in the United States.", { exact: false }),
  ).toBeVisible();
  await expectAccessible(page);

  const form = page.getByRole("form", { name: "Create a company account", exact: true });
  // A combobox by role: this form's label wraps the select, so a label match would read every country's name too.
  const country = form.getByRole("combobox", {
    name: "Country where the company is established",
    exact: true,
  });
  await expect(country).toHaveValue("");

  const slug = `vogel-${id}`;
  await form.getByLabel("Company name", { exact: true }).fill(`Vogel ${id}`);
  await form.getByLabel("Web address", { exact: true }).fill(slug);

  // The country is a question, with no answer chosen for the person.
  await form.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(
    form.getByText("Choose the country where the company is established.", { exact: true }),
  ).toBeVisible();

  await country.selectOption("DE");
  await form.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(
    form.getByText("XOS is not offered in your company's country (Germany)", { exact: false }),
  ).toBeVisible();
  await expect(form.getByLabel("Company name", { exact: true })).toHaveValue(`Vogel ${id}`);
  await expect(country).toHaveValue("DE");
  const [refused] = await sql<{ n: string }>(
    `select count(*)::text as n from app.organizations where slug = $1`,
    [slug],
  );
  expect(refused?.n).toBe("0");

  // The same form in the United States records what the person stated.
  await country.selectOption("US");
  await form.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByText(`Vogel ${id}`, { exact: true }).first()).toBeVisible();
  const [created] = await sql<{ country_code: string | null }>(
    `select country_code from app.organizations where slug = $1`,
    [slug],
  );
  expect(created?.country_code).toBe("US");
  await reloadSettled(page);
  await expect(page.getByText(`Vogel ${id}`, { exact: true }).first()).toBeVisible();
});
