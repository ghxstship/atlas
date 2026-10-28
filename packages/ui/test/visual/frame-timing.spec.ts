import { expect, test } from "@playwright/test";

/**
 * Section 11.2: 10,000 rows scroll at 60 fps (S11.2-06). Scrolls the 10,000-row DataTable story
 * (stories/Performance.stories.tsx) by a fixed distance every frame, a fast flick held for four
 * seconds, and reads each frame's start time from requestAnimationFrame.
 *
 * The budget is a p95 frame time of at most 16.7 ms. The timestamps are frame start times on the
 * display's 60 Hz clock, so a frame that meets its deadline measures 16.7 ms and one that misses
 * measures 33.3 ms or more: the budget lets at most 5 percent of frames miss. The tolerance,
 * FRAME_TOLERANCE_MS (1 ms by default), covers clock jitter and timer coarsening only; it never
 * lets a missed frame through. CI runs the check on a shared runner beside the other visual tests,
 * so a miss there is retried once (the config's retries) before it fails.
 *
 * Chromium only: frame pacing and rAF timestamps in headless Firefox and WebKit do not follow the
 * display clock, so their numbers would not measure the table.
 */
const STORY = "performance-datatable--ten-thousand-rows";
const FRAME_MS = 1000 / 60;
const TOLERANCE_MS = Number(process.env["FRAME_TOLERANCE_MS"] ?? 1);
/** Frames before the measure starts: the first scroll lays out the virtualizer's first window. */
const WARM_UP = 15;
const MEASURED = 240;
/** Pixels per frame: about 2,900 px a second, roughly 80 rows. */
const STEP = 48;

test("a 10,000-row DataTable scrolls at 60 fps", async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "Frame timing is measured in Chromium only.");
  await page.goto(`/iframe.html?id=${STORY}&viewMode=story&globals=a11y.manual:!true`);
  const region = page.getByRole("region", { name: "Purchase order lines" });
  await expect(region.getByRole("cell", { name: "NWL-1000" })).toBeVisible();

  const result = await region.evaluate(
    (el, { warmUp, measured, step }) =>
      new Promise<{ times: number[]; maxRows: number; lastKey: string }>((resolve) => {
        const times: number[] = [];
        let maxRows = 0;
        const tick = (now: number) => {
          times.push(now);
          maxRows = Math.max(maxRows, el.querySelectorAll("tbody tr").length);
          if (times.length > warmUp + measured) {
            const cells = el.querySelectorAll("tbody tr td:nth-child(2)");
            resolve({ times, maxRows, lastKey: cells[cells.length - 1]?.textContent ?? "" });
            return;
          }
          el.scrollTop += step;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { warmUp: WARM_UP, measured: MEASURED, step: STEP },
  );

  const frames = result.times
    .slice(WARM_UP)
    .slice(1)
    .map((t, i) => t - (result.times[WARM_UP + i] ?? t))
    .sort((a, b) => a - b);
  const p95 = frames[Math.ceil(frames.length * 0.95) - 1] ?? Infinity;
  const missed = frames.filter((f) => f > FRAME_MS * 1.5).length;
  info.annotations.push({
    type: "frames",
    description: `${frames.length} frames, p95 ${p95.toFixed(2)} ms, max ${frames.at(-1)?.toFixed(2)} ms, ${missed} missed`,
  });

  // The table stayed virtualized and really scrolled: about 11,500 px is row 320 or so.
  expect(result.maxRows).toBeLessThan(100);
  expect(result.lastKey).not.toBe("");
  expect(Number(result.lastKey.replace("NWL-", ""))).toBeGreaterThan(1300);
  expect(p95).toBeLessThanOrEqual(FRAME_MS + TOLERANCE_MS);
});
