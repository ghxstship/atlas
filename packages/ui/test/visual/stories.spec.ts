import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Every story in Dark, Light, Sunlight and right-to-left (Dark): axe at zero serious or critical
 * violations (Section 18 gate 8) in every engine, and a screenshot baseline in Chromium (gate 9).
 */
interface IndexEntry {
  id: string;
  type: string;
  title: string;
}

const index = JSON.parse(
  readFileSync(new URL("../../storybook-static/index.json", import.meta.url), "utf8"),
) as { entries: Record<string, IndexEntry> };

const stories = Object.values(index.entries).filter((e) => e.type === "story");

const MODES = [
  { name: "dark", globals: "theme:Dark;direction:ltr" },
  { name: "light", globals: "theme:Light;direction:ltr" },
  { name: "sunlight", globals: "theme:Sunlight;direction:ltr" },
  { name: "rtl", globals: "theme:Dark;direction:rtl" },
] as const;

/* Engine-specific checks run in browser-checks.spec.ts, which waits for tiles and sync. */
const SKIP_SCREENSHOT = new Set(["browser-checks-engines--map-view-tiles"]);

/* addon-a11y runs axe by itself after every render in the preview. Two runs at once fail with "Axe
   is already running" whenever the addon's run is still going when this suite's starts (the open
   Dialog on a busy machine, with 10.6.1 as with 10.6.2), so the addon waits for a manual run here. */
async function open(page: Page, id: string, globals: string): Promise<void> {
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=${globals};a11y.manual:!true`);
  await page.locator("#storybook-root > *").first().waitFor({ state: "attached" });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForLoadState("networkidle");
}

for (const story of stories) {
  test.describe(story.title, () => {
    for (const mode of MODES) {
      test(`axe ${mode.name} ${story.id}`, async ({ page, browserName }) => {
        await open(page, story.id, mode.globals);
        let axe = new AxeBuilder({ page })
          .include("#storybook-root")
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
        /* Contrast is a property of the token colors, which Chromium and Firefox measure. axe in
           WebKit misreads backgrounds painted on table rows and reports cells that pass in both
           other engines, so the WebKit pass runs every other rule. */
        if (browserName === "webkit") axe = axe.disableRules(["color-contrast"]);
        const results = await axe.analyze();
        const blocking = results.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map(
            (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
          );
        expect(blocking).toEqual([]);
      });

      if (!SKIP_SCREENSHOT.has(story.id)) {
        test(`@baseline ${mode.name} ${story.id}`, async ({ page }) => {
          await open(page, story.id, mode.globals);
          /* The whole page, since dialogs, drawers, peeks and popovers portal outside the root. */
          await expect(page).toHaveScreenshot(`${story.id}--${mode.name}.png`, { fullPage: true });
        });
      }
    }
  });
}
