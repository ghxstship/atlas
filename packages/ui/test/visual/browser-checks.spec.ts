import { expect, test } from "@playwright/test";

/**
 * Checks jsdom cannot make (RRR-75), in Chromium, Firefox and WebKit: MapLibre loads the style,
 * fetches raster tiles and draws over WebGL; two editors bound to linked Yjs documents converge.
 */
test("MapView draws on raster tiles", async ({ page }) => {
  const tiles: string[] = [];
  page.on("response", (r) => {
    if (r.url().includes("tile.png") && r.ok()) tiles.push(r.url());
  });
  await page.goto("/iframe.html?id=browser-checks-engines--map-view-tiles&viewMode=story");
  const canvas = page.locator(".maplibregl-canvas");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("img", { name: "Bayfront Park site map" })).toHaveClass(/opacity-0/);
  await expect.poll(() => tiles.length, { timeout: 20_000 }).toBeGreaterThan(0);
});

test("Yjs keeps two editors in sync", async ({ page }) => {
  await page.goto("/iframe.html?id=browser-checks-engines--yjs-co-editing&viewMode=story");
  const a = page.getByRole("textbox", { name: "Editor A" });
  const b = page.getByRole("textbox", { name: "Editor B" });
  await a.click();
  await page.keyboard.type("Load-in moves to 7:30");
  await expect(b).toContainText("Load-in moves to 7:30");
  await b.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" sharp");
  await expect(a).toContainText("Load-in moves to 7:30 sharp");
});
