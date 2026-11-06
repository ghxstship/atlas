import pg from "pg";
import { expect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, uniqueId } from "./support";

function localDb(): pg.Client {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Only a local stack is changed.");
  return new pg.Client({ connectionString: url });
}

/**
 * The United States launch (ADR 0160). Signup asks the organization's country and creates nothing outside an offered
 * territory, with a plain sentence that says so; a closed territory's currencies and languages are not offered; an
 * invited person abroad is untouched; and nothing about this reads where a person seems to be.
 */

test("an organization outside an offered territory is not created, and the page says why", async ({
  page,
}) => {
  const id = uniqueId();
  await signUp(page, { name: `Liesel ${id}`, email: `liesel-${id}@example.test` });
  await page.waitForURL("**/auth/organization");
  await expectAccessible(page);
  await expect(
    page.getByText("XOS is offered to organizations in the United States.", { exact: false }),
  ).toBeVisible();

  const slug = `vogel-${id}`;
  await page.getByLabel("Organization name", { exact: true }).fill(`Vogel ${id}`);
  await page.getByLabel("Web address", { exact: true }).fill(slug);
  await page.getByRole("checkbox").check();

  // The country is a question, with no answer chosen for the person.
  const country = page.getByLabel("Country where your organization is established", {
    exact: true,
  });
  await expect(country).toHaveValue("");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(
    page.getByText("Choose the country where your organization is established.", { exact: true }),
  ).toBeVisible();

  await country.selectOption("DE");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(
    page.getByText("XOS is not offered in your organization's country (Germany)", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("you do not need to create one: open your invitation", { exact: false }),
  ).toBeVisible();
  // Signing up says nothing about where an invitation works: that would imply availability abroad.
  await expect(page.getByText("wherever you are", { exact: false })).toHaveCount(0);
  await expect(page).toHaveURL(/\/auth\/organization/);
  // What the person typed stays, and the database holds nothing.
  await expect(page.getByLabel("Organization name", { exact: true })).toHaveValue(`Vogel ${id}`);
  await expect(country).toHaveValue("DE");
  const db = localDb();
  await db.connect();
  try {
    const found = await db.query("select 1 from app.organizations where slug = $1", [slug]);
    expect(found.rowCount).toBe(0);
  } finally {
    await db.end();
  }

  // The same person, stating the United States, can start one.
  await page.getByLabel("Web address", { exact: true }).fill(`${slug}-us`);
  await country.selectOption("US");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await page.waitForURL(`**/${slug}-us/home`);
});

test("a closed territory's currencies and languages are not offered", async ({ page }) => {
  const id = uniqueId();
  await signUp(page, { name: `Una ${id}`, email: `una-${id}@example.test` });
  await createOrganization(page, { name: `Una ${id}`, slug: `una-${id}` });

  await page.goto(`/una-${id}/settings/billing-and-plan`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  await expect(page.getByText("Prices in US dollars before tax.", { exact: true })).toBeVisible();
  const billing = await page.locator("main").innerText();
  for (const closed of ["EUR", "GBP", "CAD", "AUD", "€", "£", "EU data residency"]) {
    expect(billing).not.toContain(closed);
  }

  // The language menu holds English and Spanish.
  await page.getByRole("button", { name: "Account" }).first().click();
  await expect(
    page.getByRole("menuitem", { name: "Español (EE. UU.)", exact: false }),
  ).toBeVisible();
  for (const closed of ["Français", "Deutsch", "Italiano", "Português", "日本語"]) {
    await expect(page.getByRole("menuitem", { name: closed, exact: false })).toHaveCount(0);
  }
  await page.keyboard.press("Escape");

  // So does the Language setting, on a page that lists every registered choice otherwise.
  await page.goto(`/una-${id}/me/preferences`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  const options = await page
    .getByLabel("Language", { exact: true })
    .locator("option")
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
  expect(options).toEqual(["en-US", "es-US"]);
});

test("a saved choice of a closed language reads as no choice, and a browser in German gets English", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    ...(baseURL ? { baseURL } : {}),
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    extraHTTPHeaders: { "Sec-GPC": "1", "Accept-Language": "de-DE,de;q=0.9" },
  });
  await context.addCookies([
    { name: "xos-locale", value: "fr-FR", url: baseURL ?? "http://127.0.0.1:3006" },
  ]);
  const page = await context.newPage();
  await page.goto("/auth/sign-in");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await context.close();
});

/** An invitation to the demo organization, written the way app.invite_member writes one. Returns its token. */
async function inviteToDemoOrg(email: string): Promise<string> {
  const db = localDb();
  await db.connect();
  try {
    const issued = await db.query<{ token: string }>(
      "select private.issue_invite_token() as token",
    );
    const token = issued.rows[0]?.token ?? "";
    await db.query(
      `insert into app.invites (org_id, email, role_id, token_hash, expires_at, invited_by)
       select o.id, $1, private.system_role_id('member'), private.invite_token_hash($2), now() + interval '1 day', m.person_id
       from app.organizations o
       join app.memberships m on m.org_id = o.id and m.deleted_at is null
       where o.slug = 'demo-productions'
       limit 1`,
      [email, token],
    );
    return token;
  } finally {
    await db.end();
  }
}

test("a crew member abroad, invited by a US organization, signs up and works with no country asked", async ({
  browser,
  baseURL,
}) => {
  const id = uniqueId();
  const email = `tomas-${id}@example.test`;
  const token = await inviteToDemoOrg(email);

  const context = await browser.newContext({
    ...(baseURL ? { baseURL } : {}),
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    extraHTTPHeaders: { "Sec-GPC": "1", "Accept-Language": "de-DE,de;q=0.9" },
  });
  const page = await context.newPage();
  await signUp(page, {
    name: `Tomas ${id}`,
    email,
    next: `/auth/invite/${token}`,
  });
  await page.waitForURL(`**/auth/invite/${token}`);
  await expect(page.getByLabel("Country", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
  await page.waitForURL("**/demo-productions/**");
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await context.close();
});

test.describe("opening a territory", () => {
  test.skip(
    process.env["E2E_PRODUCTION_BUILD"] === "1",
    "A production server keeps the offering for a minute; this journey needs the change at once.",
  );

  test("needs no code: once it is open, its country can start an organization", async ({
    page,
  }) => {
    const id = uniqueId();
    const db = localDb();
    await db.connect();
    await signUp(page, { name: `Rene ${id}`, email: `rene-${id}@example.test` });
    await page.waitForURL("**/auth/organization");
    const fill = async (slug: string, code: string) => {
      await page.getByLabel("Organization name", { exact: true }).fill(`Thames ${id}`);
      await page.getByLabel("Web address", { exact: true }).fill(slug);
      await page
        .getByLabel("Country where your organization is established", { exact: true })
        .selectOption(code);
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Create organization", exact: true }).click();
    };
    try {
      await fill(`thames-${id}`, "GB");
      await expect(
        page.getByText("XOS is not offered in your organization's country (United Kingdom)", {
          exact: false,
        }),
      ).toBeVisible();
      await db.query("update private.territories set offered = true where code = 'GB'");
      await fill(`thames-${id}`, "GB");
      await page.waitForURL(`**/thames-${id}/home`);
    } finally {
      await db.query("update private.territories set offered = false where code = 'GB'");
      await db.end();
    }
  });
});
