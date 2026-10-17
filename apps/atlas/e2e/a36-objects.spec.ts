import { expect, test } from "@playwright/test";
import { expectAccessibleInBothThemes } from "./a16-support";
import { DEMO_ORG, signInAs } from "./a36-support";
import { uniqueId } from "./support";

/**
 * Journey 28 (Section 20.2, Section 4.6.3): define a custom object with a Choice field in Settings, add
 * records, view them as a board, move one, and read them through the API. Journey 32's "Why can I see
 * this" is checked on the record peek.
 */
test("journey 28: define a custom object, add records, view the board and read the API", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const id = uniqueId();
  const label = `Stage Props ${id.toUpperCase()}`;
  const key = `stage_props_${id}`;

  await signInAs(page, "admin@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/settings/custom-objects`);
  await expect(page.getByRole("heading", { name: "Custom objects", level: 2 })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // Define the object, then its Choice field.
  await page.getByLabel("Name", { exact: true }).fill(label);
  await page.getByRole("button", { name: "Define the object" }).click();
  await expect(page.getByText("Object defined. Add its fields next.")).toBeVisible();
  const card = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: label }) });
  await expect(card.getByText(`/api/v1/objects/${key}`)).toBeVisible();
  await card.getByText(`Add a field to ${label}`).click();
  await card.getByLabel("Field name").fill("Status");
  await card.getByLabel("Type").selectOption("Choice");
  await card.getByLabel("Options").fill("Requested\nBuilt");
  await card.getByLabel("Every record needs a value").check();
  await card.getByRole("button", { name: "Add the field" }).click();
  await expect(card.getByText("Status · Choice · required")).toBeVisible();

  // Records: the empty state leads to the create flow.
  await card.getByRole("link", { name: `Open ${label} records` }).click();
  await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
  await expect(page.getByText(`No ${label} records yet. Create the first one.`)).toBeVisible();
  await expectAccessibleInBothThemes(page);
  for (const title of ["Breakaway table", "Prop sword"]) {
    await page
      .getByRole("link", { name: `New ${label} record` })
      .first()
      .click();
    const drawer = page.getByRole("dialog", { name: `New ${label} record` });
    await drawer.getByLabel("Title").fill(title);
    await drawer.getByRole("button", { name: "Create the record" }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByText(title).first()).toBeVisible();
  }

  // Board: grouped by Status; move one record to Built from its peek.
  await page.getByRole("radio", { name: "List" }).click();
  await expect(page).toHaveURL(/view=list/);
  await page.getByRole("radio", { name: "Board" }).click();
  await expect(page).toHaveURL(/view=board/);
  await expect(page.getByText("Requested").first()).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await page.getByRole("button", { name: /Prop sword/ }).dblclick();
  const peek = page.getByRole("dialog", { name: /Prop sword/ });
  // Why can I see this: the admin's membership and the read rule.
  await expect(peek.getByText("Why can I see this?")).toBeVisible();
  await peek.getByText("Why can I see this?").click();
  await expect(peek.getByText("Your membership and roles")).toBeVisible();
  await expect(peek.getByText("Read rule", { exact: true })).toBeVisible();

  // Move the record to Built; the board shows it there once the peek closes.
  await peek.getByRole("combobox", { name: "Status" }).selectOption({ label: "Built" });
  await peek.getByRole("button", { name: "Move" }).click();
  await expect(
    page
      .getByRole("dialog", { name: /Prop sword/ })
      .getByText("Built")
      .first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Built" })).toContainText("Prop sword");

  // API read with the session.
  const response = await page.request.get(`/api/v1/objects/${key}`, {
    headers: { Origin: baseURL ?? "" },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { data: { title: string }[] };
  expect(body.data.map((r) => r.title).sort()).toEqual(["Breakaway table", "Prop sword"]);
});
