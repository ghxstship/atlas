import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * Page checks for the A23 sweep. Each returns a list of problems, empty when the page passes, so a
 * test can report every problem on a route at once. apps/atlas/e2e/a11y/checks.ts keeps the same
 * checks for Atlas.
 */

/** WCAG 2.0, 2.1 and 2.2 at Levels A and AA. */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

export type Theme = "dark" | "light";

/** Switches the theme in place and stops transitions, so axe never samples a half-switched page. */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
  });
  await page.evaluate((t) => {
    document.documentElement.dataset["theme"] = t;
  }, theme);
}

/** Serious and critical axe violations, as `rule: targets`. */
export async function axeProblems(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `axe ${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

/** WCAG 1.4.10: no horizontal page scroll at 320 CSS px equivalent (checked at 375 px). */
export async function overflowProblems(page: Page): Promise<string[]> {
  const width = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scroll: doc.scrollWidth, client: doc.clientWidth };
  });
  return width.scroll > width.client + 1
    ? [`overflow: page scrolls horizontally (${width.scroll} px content in ${width.client} px)`]
    : [];
}

/**
 * WCAG 2.4.7 and 2.4.11: the first focus stops each show an indicator. In an app shell the first
 * stop must also be a skip link (2.4.1); single-form pages (auth, token flows) repeat no blocks.
 */
export async function focusProblems(
  page: Page,
  { skipLink = true, stops = 6 }: { skipLink?: boolean; stops?: number } = {},
): Promise<string[]> {
  const problems: string[] = [];
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  for (let i = 0; i < stops; i += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      // The indicator may sit on the control or, through :focus-within, on a close ancestor.
      const shows = (node: Element | null): boolean => {
        if (!node) return false;
        const s = getComputedStyle(node);
        const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
        const ring = s.boxShadow !== "none" && s.boxShadow !== "";
        return outline || ring;
      };
      const visible =
        shows(el) || shows(el.parentElement) || shows(el.parentElement?.parentElement ?? null);
      const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
      const href = el.getAttribute("href") ?? "";
      return { tag: el.tagName.toLowerCase(), name, href, visible };
    });
    if (stop === null) {
      if (i === 0) problems.push("focus: Tab from the top of the page focuses nothing");
      break;
    }
    if (skipLink && i === 0 && !stop.href.startsWith("#")) {
      problems.push(`focus: first stop is ${stop.tag} "${stop.name}", not a skip link`);
    }
    if (!stop.visible) problems.push(`focus: no visible indicator on ${stop.tag} "${stop.name}"`);
  }
  return problems;
}

/**
 * Gate 31: every visible icon-only control has an accessible name and a tooltip. A tooltip is a
 * `title` or a tooltip trigger (the design system Tooltip marks its trigger with data-state).
 */
export async function iconControlProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const controls = document.querySelectorAll<HTMLElement>(
      "button, a[href], [role='button'], [role='tab'], [role='menuitem']",
    );
    for (const el of controls) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if ((el.innerText ?? "").trim() !== "") continue;
      if (!el.querySelector("svg, img")) continue;
      const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .join(" ")
        .trim();
      const alt = el.querySelector("img")?.getAttribute("alt") ?? "";
      const name = (el.getAttribute("aria-label") ?? "").trim() || labelledBy || alt.trim();
      const title = (el.getAttribute("title") ?? "").trim();
      const tooltip = title !== "" || el.hasAttribute("data-state");
      const id = el.id ? `#${el.id}` : (el.className.toString().split(" ")[0] ?? "");
      if (!name && !title) out.push(`icon control: ${el.tagName.toLowerCase()}${id} has no name`);
      else if (!tooltip) out.push(`icon control: "${name}" has no tooltip`);
    }
    return out;
  });
}
