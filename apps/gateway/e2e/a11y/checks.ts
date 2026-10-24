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
  // Start sequential navigation at the top: blur alone keeps the old starting point, so a page that
  // focused a control further down would make the first Tab look like it focuses nothing.
  await page.evaluate(() => {
    const start = document.createElement("span");
    start.tabIndex = -1;
    start.dataset["a11yStart"] = "true";
    document.body.prepend(start);
    start.focus();
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
  await page.evaluate(() => document.querySelector("[data-a11y-start]")?.remove());
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

/**
 * Gate 27 (cognitive load): no screen has more than one primary action, more than 5 visible toolbar
 * actions, or more than 7 visible form fields before "More fields" (collapsed fields are not
 * visible, and neither is what a closed <details> holds outside its summary). An open dialog is its
 * own screen; the page behind it is not counted.
 */
export async function cognitiveLoadProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const visible = (el: Element) => {
      // An inert subtree (a brand color preview) shows controls nobody can use.
      if (el.closest("[inert]")) return false;
      // Chromium hides a closed <details> with content-visibility, which still reports a size.
      const summary = el.closest("summary");
      for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) {
        if (!d.open && summary?.parentElement !== d) return false;
      }
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden";
    };
    const dialog = [...document.querySelectorAll("[role='dialog'], [role='alertdialog']")].find(
      visible,
    );
    const screen = dialog ?? document.querySelector("main") ?? document.body;
    const primaries = [...screen.querySelectorAll("button.xos-fill-accent, a.xos-fill-accent")]
      .filter(visible)
      .filter((el) => dialog || !el.closest("[role='dialog'], [role='alertdialog']"));
    if (primaries.length > 1) {
      const names = primaries.map(
        (p) => (p.textContent ?? "").trim() || p.getAttribute("aria-label"),
      );
      out.push(`cognitive load: ${primaries.length} primary actions (${names.join(", ")})`);
    }
    const groups = [
      ...screen.querySelectorAll("[role='toolbar']"),
      ...[...screen.querySelectorAll("header")].map((h) =>
        h.querySelector(":scope > div:last-child"),
      ),
    ].filter((g): g is Element => g !== null && visible(g));
    for (const g of groups) {
      const actions = [...g.querySelectorAll("button, a[href], [role='button']")]
        .filter(visible)
        .filter((el) => !el.closest("[role='radiogroup'], [role='tablist']"));
      if (actions.length > 5) {
        const label = g.getAttribute("aria-label") ?? "page header";
        out.push(`cognitive load: ${actions.length} toolbar actions in ${label}`);
      }
    }
    const forms = dialog ? [dialog] : [...screen.querySelectorAll("form")];
    for (const f of forms) {
      const seen = new Set<string>();
      let count = 0;
      for (const el of f.querySelectorAll<HTMLElement>(
        "input, select, textarea, [role='combobox'], [role='switch']",
      )) {
        if (!visible(el)) continue;
        const type = el.getAttribute("type") ?? "";
        if (["hidden", "submit", "button", "reset"].includes(type)) continue;
        if (type === "search") continue;
        const key =
          type === "radio" ? `radio:${el.getAttribute("name")}` : `el:${count}:${seen.size}`;
        if (seen.has(key)) continue;
        seen.add(key);
        count += 1;
      }
      if (count > 7) {
        const label = f.getAttribute("aria-label") ?? f.id ?? (dialog ? "dialog" : "form");
        out.push(`cognitive load: ${count} visible fields in ${label || "a form"}`);
      }
    }
    return out;
  });
}
