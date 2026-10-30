import type { Page } from "@playwright/test";
import { expect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A129 (RRR-174, Section 11.6): Home stands on the Dashboard template, a 12-column grid of tiles. A
 * new Owner widens the plan tile with the keyboard and narrows the checklist by dragging its edge; a
 * screen reader hears each span, the spans survive a reload because they are the person's own
 * me.dashboard_layout.home setting, Personal settings > Preferences says the layout is arranged, and
 * Reset layout puts every tile back. A fresh account each run, so no other journey sees the layout.
 */

test.use({ reducedMotion: "reduce" });

const span = (page: Page, tile: string) =>
  page.locator(`[data-template='dashboard'] [data-tile='${tile}']`).getAttribute("data-span");

test("Home keeps the spans a person gives its tiles", async ({ page }, info) => {
  test.skip(info.project.name.startsWith("phone"), "below md the grid is one column");
  test.setTimeout(180_000);
  const id = uniqueId();
  await signUp(page, { name: "Dana Layout", email: testEmail("a129-layout", id) });
  await createOrganization(page, { name: `Layout ${id}`, slug: `layout-${id}` });
  await page.setViewportSize({ width: 1280, height: 900 });

  await expect(page.locator("main [data-template]")).toHaveCount(1);
  await expect(page.locator("main [data-template='dashboard']")).toBeVisible();
  expect(await span(page, "plan")).toBe("4");
  expect(await span(page, "checklist")).toBe("8");

  // Keyboard: the plan tile's handle takes the arrow keys, one column a press.
  const plan = page.getByRole("separator", { name: "Resize Your plan" });
  await plan.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(plan).toHaveAttribute("aria-valuenow", "6");
  await expect(page.locator("[data-template='dashboard'] [aria-live='polite']")).toHaveText(
    "Your plan, 6 of 12 columns",
  );

  // Pointer: drag the checklist's edge two grid units toward the start.
  const checklist = page.getByRole("separator", { name: /^Resize Get Layout / });
  const grid = await page
    .locator("[data-template='dashboard'] [data-tile]")
    .first()
    .evaluate((el) => {
      const g = el.parentElement as HTMLElement;
      const gap = parseFloat(getComputedStyle(g).columnGap) || 0;
      return (g.clientWidth - 11 * gap) / 12 + gap;
    });
  const box = await checklist.boundingBox();
  if (!box) throw new Error("The checklist handle has no box.");
  // The save is a server action whose body carries every span; wait for the one with this drag in it.
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && (r.request().postData() ?? "").includes('"checklist":6'),
  );
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - grid * 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(checklist).toHaveAttribute("aria-valuenow", "6");
  await saved;
  await expectAccessible(page);

  await page.reload();
  expect(await span(page, "plan")).toBe("6");
  expect(await span(page, "checklist")).toBe("6");

  await page.goto(`/layout-${id}/me/preferences`);
  await expect(page.getByText("You arranged this dashboard.", { exact: false })).toBeVisible();

  await page.goto(`/layout-${id}/home`);
  const reset = page.waitForResponse((r) => {
    const body = r.request().postData() ?? "";
    return r.request().method() === "POST" && body.includes('"home"') && !body.includes("{");
  });
  await page.getByRole("button", { name: "Reset layout" }).click();
  await reset;
  expect(await span(page, "plan")).toBe("4");
  await page.reload();
  expect(await span(page, "plan")).toBe("4");
  expect(await span(page, "checklist")).toBe("8");
  await expect(page.getByRole("button", { name: "Reset layout" })).toHaveCount(0);
});
