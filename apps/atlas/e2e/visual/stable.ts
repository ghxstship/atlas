import type { BrowserContext, Locator, Page } from "@playwright/test";

/**
 * Making a page screenshot repeatable (Section 18, gate 9). The visual clock every run shares, the
 * four modes each core screen is rendered in, the wait for a page to finish drawing, and the
 * volatile regions that are masked: dates, times, relative times and generated ids. With the clock
 * fixed, a date is the same on every run; the masks still hide the seconds a seeded row was written
 * at and the ids a reset generates. apps/gateway/e2e/visual/stable.ts keeps the same code for Gateway.
 */

export const MODES = ["dark", "light", "rtl", "sunlight"] as const;
export type Mode = (typeof MODES)[number];

/**
 * The shift from the real clock to the visual clock, which packages/testing/ci/visual-clock.sh
 * prints. A core screen is a picture of the demo tenant at one instant: the database is migrated and
 * seeded with its clock there, so the seed's dates relative to the reset (today's shifts, the Field
 * Tech's last two days) and its fixed March 2027 dates keep the same distance from "now"; the Next
 * server runs on the same shifted clock (packages/testing/clock/node-clock.cjs). Before, the shot
 * followed the date of the run: this week, today and overdue covered different rows by weekday.
 */
export const CLOCK_OFFSET_MS = Number(process.env["E2E_CLOCK_OFFSET_MS"] ?? 0);

/**
 * Moves a context's clock to the visual clock before its first page loads, so what the page formats
 * itself (a relative time, a calendar's today) agrees with the server. Time keeps flowing.
 */
export async function followVisualClock(context: BrowserContext): Promise<void> {
  await context.clock.setSystemTime(performance.timeOrigin + performance.now() + CLOCK_OFFSET_MS);
}

/** The stylesheet applied while each screenshot is taken (dev indicator, carets, help cards). */
export const SCREENSHOT_CSS = new URL("./screenshot.css", import.meta.url).pathname;

/**
 * Sets the cookies a mode needs before the page loads. Right to left is the ar-XB pseudo-locale,
 * which only development builds offer (i18n/negotiate.ts). Sunlight is the third theme (ADR 0009,
 * D3): Atlas keeps only Dark and Light in its theme cookie, so the page renders Light, the theme
 * Sunlight derives from, and `applyModeAfterLoad` switches the document to Sunlight.
 */
export async function applyModeBeforeLoad(
  context: BrowserContext,
  baseURL: string,
  mode: Mode,
): Promise<void> {
  const theme = mode === "light" || mode === "sunlight" ? "light" : "dark";
  await context.clearCookies({ name: "xos-locale" });
  await context.addCookies([
    { name: "xos-theme", value: theme, url: baseURL },
    ...(mode === "rtl" ? [{ name: "xos-locale", value: "ar-XB", url: baseURL }] : []),
  ]);
}

export async function applyModeAfterLoad(page: Page, mode: Mode): Promise<void> {
  if (mode !== "sunlight") return;
  await page.evaluate(() => {
    document.documentElement.dataset["theme"] = "sunlight";
  });
}

/**
 * Waits until the page has finished drawing: the network is quiet (capped, since a live page keeps
 * a request open), web fonts have loaded, and nothing is marked busy or still a skeleton.
 */
export async function untilDrawn(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page
    .waitForFunction(
      () =>
        document.querySelector("[aria-busy='true'], [data-skeleton], .xos-skeleton") === null &&
        !document.querySelector("nextjs-portal")?.shadowRoot?.querySelector("[data-nextjs-toast]"),
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
}

/**
 * Marks every element whose own text holds a volatile value with `data-visual-mask` and returns a
 * locator for them, for `toHaveScreenshot({ mask })`. The pseudo-locale accents are undone first,
 * so a relative time inside an ar-XB message is found as well.
 */
export async function volatileRegions(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    const accents = "àƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÀƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ";
    const plain = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const unaccent = (text: string) =>
      [...text].map((c) => plain[accents.indexOf(c)] ?? c).join("");
    const month =
      "(Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\\.?";
    const weekday =
      "(Mon|Monday|Tue|Tues|Tuesday|Wed|Wednesday|Thu|Thurs|Thursday|Fri|Friday|Sat|Saturday|Sun|Sunday)";
    const unit = "(second|sec|minute|min|hour|hr|day|week|month|year)s?";
    const volatile = [
      new RegExp(`\\b${month}\\s+\\d{1,2}\\b`),
      new RegExp(`\\b\\d{1,2}\\s+${month}\\b`),
      new RegExp(`\\b${weekday}\\b`),
      /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/,
      /\b\d{4}-\d{2}-\d{2}\b/,
      /\b\d{1,2}:\d{2}\b/,
      new RegExp(`\\b\\d+\\s*${unit}\\b`, "i"),
      /\b(ago|just now|yesterday)\b/i,
      /\bgood (morning|afternoon|evening)\b/i,
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
      /[0-9A-HJKMNP-TV-Z]{26}/,
    ];
    const ownText = (el: Element) =>
      [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("");
    for (const el of document.querySelectorAll("[data-visual-mask]")) {
      el.removeAttribute("data-visual-mask");
    }
    for (const el of document.body.querySelectorAll("*")) {
      if (el.closest("script, style, noscript, template")) continue;
      const text = unaccent(ownText(el));
      const timeLike =
        el.tagName === "TIME" ||
        (el instanceof HTMLInputElement &&
          ["date", "datetime-local", "time", "month", "week"].includes(el.type));
      if (timeLike || volatile.some((re) => re.test(text))) {
        el.setAttribute("data-visual-mask", "");
        // The mask covers the element's box, and a date's width changes with the date ("Nov 3"
        // against "Oct 26"), so a masked cell still moved the shot every day, most visibly in right
        // to left where the box grows from the start edge (A71). One fixed text gives every volatile
        // element the same footprint on every run.
        for (const node of el.childNodes) {
          if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "") {
            node.textContent = "0000-00-00 00:00";
          }
        }
      }
    }
  });
  return page.locator("[data-visual-mask]");
}
