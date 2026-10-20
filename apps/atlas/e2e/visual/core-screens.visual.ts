import { expect, test } from "@playwright/test";
import { SCREENS, storageStatePath } from "./screens";
import {
  applyModeAfterLoad,
  applyModeBeforeLoad,
  MODES,
  SCREENSHOT_CSS,
  untilDrawn,
  volatileRegions,
} from "./stable";

/**
 * Gate 9: a baseline per Atlas core screen in Dark, Light, right to left and Sunlight, per
 * viewport project (desktop-1280, phone-375). A failure attaches the expected, actual and diff
 * images; after an intended change, regenerate with VISUAL_UPDATE_SNAPSHOTS=changed in the pinned
 * image (playwright.visual.config.ts).
 */
for (const screen of SCREENS) {
  test.describe(screen.name, () => {
    test.use({ storageState: storageStatePath(screen.person) });

    for (const mode of MODES) {
      test(`${screen.name} in ${mode} @baseline`, async ({ page, context, baseURL }) => {
        await applyModeBeforeLoad(context, baseURL as string, mode);
        const response = await page.goto(screen.path);
        expect(response?.status(), `${screen.path} answers`).toBeLessThan(400);
        await expect(page.locator("html")).toHaveAttribute("dir", mode === "rtl" ? "rtl" : "ltr");
        await applyModeAfterLoad(page, mode);
        await untilDrawn(page);
        await expect(page).toHaveScreenshot(`${screen.name}-${mode}.png`, {
          mask: [await volatileRegions(page)],
          stylePath: SCREENSHOT_CSS,
        });
      });
    }
  });
}
