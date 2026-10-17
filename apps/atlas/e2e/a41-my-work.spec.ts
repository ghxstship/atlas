import { expect, test } from "./engine-test";
import { expectAccessibleInBothThemes, ORG, signIn } from "./operations-support";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * My Work (Section 4.5.4, A24-002): the Producer's open records across projects, grouped by due
 * state, in each view the switcher offers; a record opens in the side peek. A person with nothing
 * assigned sees the empty state and its next action. Runs on the demo tenant seed, where the
 * Producer owns NWS-14 (due in March 2027) and NWS-13 (no date).
 */

test.use({ reducedMotion: "reduce" });

test("My Work groups the viewer's records by due state in every view", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/my-work`);
  await expect(page.getByRole("heading", { level: 1, name: "My Work" })).toBeVisible();
  for (const group of ["Overdue", "Today", "Upcoming", "No due date"]) {
    await expect(
      page.getByRole("heading", { level: 2, name: new RegExp(`^${group}`) }),
    ).toBeVisible();
  }
  const upcoming = page.getByRole("region", { name: /^Upcoming/ });
  await expect(upcoming.getByText("Fire Marshal Walk")).toBeVisible();
  const undated = page.getByRole("region", { name: /^No due date/ });
  await expect(undated.getByText("Afternoon Thunderstorm")).toBeVisible();
  await expect(
    page.getByRole("region", { name: /^Overdue/ }).getByText("Nothing overdue."),
  ).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // Icons draw from the cached sprite (ADR 0027): decorative ones are hidden from assistive
  // technology and the sprite is a static asset browsers keep.
  const use = page.locator("svg[aria-hidden='true'] > use").first();
  const href = (await use.getAttribute("href")) ?? "";
  expect(href).toMatch(/\.svg#[A-Z]\w+$/);
  const sprite = await page.request.get(href.split("#")[0] as string);
  expect(sprite.status()).toBe(200);
  expect(sprite.headers()["content-type"]).toContain("image/svg+xml");
  if (process.env["E2E_PRODUCTION_BUILD"] === "1") {
    expect(sprite.headers()["cache-control"]).toContain("immutable");
  }
  expect(await sprite.text()).toContain(`<symbol id="${href.split("#")[1]}"`);

  // Browser error reports name the signed-in person by id, never by email (ADR 0025).
  // The reporter sends a Blob beacon, whose body Playwright does not expose, so read it in the page.
  const payload = await page.evaluate(async () => {
    const send = navigator.sendBeacon.bind(navigator);
    const body = new Promise<string>((resolve) => {
      navigator.sendBeacon = (url, data) => {
        if (String(url).endsWith("/api/client-errors") && data instanceof Blob) {
          void data.text().then(resolve);
        }
        return send(url, data);
      };
    });
    void Promise.reject(new Error("My Work reporter check"));
    return body;
  });
  expect(JSON.parse(payload)).toMatchObject({
    userId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  });
  expect(payload).not.toContain("producer@example.com");

  // A record opens in the shell's side peek.
  await upcoming
    .getByRole("row", { name: /Fire Marshal Walk/ })
    .getByRole("button", { name: "Open" })
    .click();
  const peek = page.getByRole("dialog", { name: /Fire Marshal Walk/ });
  await expect(peek).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();

  // Table, board and calendar keep the same records.
  await page.goto(`/${ORG}/my-work?view=table`);
  await expect(page.getByRole("grid").getByText("Fire Marshal Walk")).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await page.goto(`/${ORG}/my-work?view=board`);
  await expect(page.getByText("NWS-14 Fire Marshal Walk")).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await page.goto(`/${ORG}/my-work?view=calendar&month=2027-03`);
  await expect(page.getByText("NWS-14 Fire Marshal Walk")).toBeVisible();
  await expect(page.getByText(/no date and (is|are) left off the calendar/)).toBeVisible();
  await expectAccessibleInBothThemes(page);
});

test("My Work names the next step when nothing is assigned", async ({ page }) => {
  const id = uniqueId();
  const slug = `my-work-${id}`;
  await signUp(page, { name: "Mo Work", email: testEmail("mywork", id) });
  await createOrganization(page, { name: `My Work ${id}`, slug });
  await page.goto(`/${slug}/my-work`);
  await expect(page.getByText(/Nothing is assigned to you yet/)).toBeVisible();
  await page.getByRole("button", { name: "Open Projects" }).click();
  await expect(page).toHaveURL(new RegExp(`/${slug}/projects`));
});
