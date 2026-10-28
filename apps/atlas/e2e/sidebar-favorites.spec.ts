import type { Page } from "@playwright/test";
import { expect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A113 (RRR-158, finding A65-024; Sections 4.5.2 and 11.7): the Favorites in the Atlas sidebar move by keyboard,
 * a screen reader hears each step, and the new order survives a reload; the pinned Projects entry lists the
 * projects the person opened most recently, newest first, then All Projects. Each journey signs up a new person
 * with their own org, so nothing it changes reaches another journey.
 */
test.use({ reducedMotion: "reduce" });
// Sign-up, a new org and a first visit to each page take a while under next dev.
test.describe.configure({ timeout: 180_000 });

async function newOrg(page: Page, label: string): Promise<string> {
  const id = uniqueId();
  const slug = `${label}-${id}`;
  await signUp(page, { name: "Robin Rows", email: testEmail(label, id) });
  await createOrganization(page, { name: `Rows ${id}`, slug });
  return slug;
}

/** Pins the page at `path` with the sidebar's Pin page button. */
async function pin(page: Page, path: string) {
  await page.goto(path);
  const favorites = page.getByRole("region", { name: "Favorites" });
  await favorites.getByRole("button", { name: "Pin page" }).click();
  await expect(favorites.getByRole("button", { name: "Unpin page" })).toBeVisible();
}

/** Resolves when the next server action (a POST with a Next-Action header) has answered. */
function nextAction(page: Page) {
  return page.waitForResponse(
    (r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined,
  );
}

async function createProject(page: Page, slug: string, key: string, name: string) {
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill(key);
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/${key}/overview`);
}

test("a person reorders favorites by keyboard and by mouse, hears each step, and the order survives a reload", async ({
  page,
}) => {
  const slug = await newOrg(page, "favorites");
  await pin(page, `/${slug}/home`);
  await pin(page, `/${slug}/inbox`);
  await pin(page, `/${slug}/my-work`);
  const favorites = page.getByRole("navigation", { name: "Favorites" });
  await expect(favorites.getByRole("link")).toHaveText(["Home", "Inbox", "My Work"]);

  // Space picks up, the arrows move, Space drops; a screen reader hears each step.
  const handle = favorites.getByRole("button", { name: "Move My Work" });
  await handle.focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByText("My Work picked up, position 3 of 3.", { exact: false }),
  ).toBeAttached();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByText("My Work moved to position 2 of 3.")).toBeAttached();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByText("My Work moved to position 1 of 3.")).toBeAttached();
  const saved = nextAction(page);
  await page.keyboard.press("Space");
  await expect(page.getByText("My Work dropped at position 1 of 3.")).toBeAttached();
  await saved;
  await expect(handle).toBeFocused();
  await expect(favorites.getByRole("link")).toHaveText(["My Work", "Home", "Inbox"]);
  await expectAccessible(page);

  // Esc puts a favorite back where it was picked up, and nothing is saved.
  await favorites.getByRole("button", { name: "Move Inbox" }).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await expect(favorites.getByRole("link")).toHaveText(["My Work", "Inbox", "Home"]);
  await page.keyboard.press("Escape");
  await expect(page.getByText("Inbox put back at position 3 of 3.")).toBeAttached();
  await expect(favorites.getByRole("link")).toHaveText(["My Work", "Home", "Inbox"]);

  await page.reload();
  await expect(favorites.getByRole("link")).toHaveText(["My Work", "Home", "Inbox"]);

  // After a load the list is plain until focus reaches it; then the move buttons appear and the favorite keeps focus.
  const first = favorites.getByRole("link", { name: "My Work" });
  await first.focus();
  await expect(favorites.getByRole("button", { name: "Move My Work" })).toBeVisible();
  await expect(first).toBeFocused();

  // By mouse: a favorite dropped on another takes its place, a screen reader hears it, and the order is saved.
  const dropped = nextAction(page);
  await favorites
    .getByRole("listitem")
    .filter({ hasText: "Inbox" })
    .dragTo(favorites.getByRole("listitem").filter({ hasText: "My Work" }));
  await expect(page.getByText("Inbox dropped at position 1 of 3.")).toBeAttached();
  await dropped;
  await expect(favorites.getByRole("link")).toHaveText(["Inbox", "My Work", "Home"]);
  await page.reload();
  await expect(favorites.getByRole("link")).toHaveText(["Inbox", "My Work", "Home"]);
});

test("the projects a person opens appear under Projects, newest first, then All Projects", async ({
  page,
}) => {
  const slug = await newOrg(page, "recent");
  const main = page.getByRole("navigation", { name: "Main" });
  await expect(main.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
  await expect(main.getByRole("list", { name: "Recent projects" })).toHaveCount(0);

  await createProject(page, slug, "NWL", "Northwind Summer Series");
  await createProject(page, slug, "HLP", "Harbor Lights Pier Nights");
  const recent = main.getByRole("list", { name: "Recent projects" });
  await expect(recent.getByRole("link")).toHaveText([
    "Harbor Lights Pier Nights",
    "Northwind Summer Series",
    "All Projects",
  ]);
  await expectAccessible(page);

  // Opening one by mouse moves it to the top at once, without a reload, and marks it as the current page.
  await recent.getByRole("link", { name: "Northwind Summer Series" }).click();
  await page.waitForURL(new RegExp(`/${slug}/p/NWL`));
  await expect(recent.getByRole("link")).toHaveText([
    "Northwind Summer Series",
    "Harbor Lights Pier Nights",
    "All Projects",
  ]);
  await expect(recent.getByRole("link", { name: "Northwind Summer Series" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // By keyboard: All Projects opens with Enter, and the list is still there after a reload.
  await recent.getByRole("link", { name: "All Projects" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(new RegExp(`/${slug}/projects/all$`));
  await page.reload();
  await expect(recent.getByRole("link")).toHaveText([
    "Northwind Summer Series",
    "Harbor Lights Pier Nights",
    "All Projects",
  ]);
  await expectAccessible(page);
});
