import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buttonClass } from "../src/Button/button-class.ts";
import { linkClass } from "../src/Link/link-class.ts";
import * as entry from "../src/ConsentBanner/static.ts";
import { ConsentBannerStatic } from "../src/ConsentBanner/static.ts";
import { expectAccessible } from "./a11y.ts";

/**
 * The script-free cookie banner (issue 107, ADR 0027): the banner Atlas shows on every route. It
 * must stay free of hooks, context and event handlers, keep Accept and Reject equal, tick nothing,
 * and post the same fields as ConsentBanner's forms.
 */

const COPY = {
  title: "Cookies",
  body: "We use cookies to keep you signed in.",
  policy: { label: "Cookie Policy", href: "/legal/cookie-policy" },
  settings: { label: "Cookie settings", href: "/legal/cookie-settings" },
  acceptLabel: "Accept all",
  rejectLabel: "Reject all",
  chooseLabel: "Choose cookies",
  necessary: "Strictly necessary: always on.",
  categories: [
    { name: "preferences", label: "Preferences: remember your language and theme." },
    { name: "analytics_storage", label: "Performance: page timing and error reports." },
  ],
  saveLabel: "Save choices",
  action: "/consent",
};

/* Vitest runs from the package root; jsdom gives import.meta.url no file path. */
const source = (file: string): string =>
  readFileSync(join(process.cwd(), "src/ConsentBanner", file), "utf8");

describe("ConsentBannerStatic sends no script", () => {
  it("has no client directive, hook or event handler, and its entry imports no client module", () => {
    const component = source("ConsentBannerStatic.tsx");
    expect(component).not.toContain('"use client"');
    expect(component).not.toMatch(/\buse[A-Z]\w*\(/);
    expect(component).not.toMatch(/\bon[A-Z]\w*=/);
    // Every module the entry loads at run time, any number of hops away. Type-only imports and
    // exports are erased, so the client ConsentBanner the types come from is not followed.
    const root = join(process.cwd(), "src/ConsentBanner");
    const visited = new Set<string>();
    const offending: string[] = [];
    const visit = (file: string): void => {
      if (visited.has(file)) return;
      visited.add(file);
      const text = readFileSync(file, "utf8");
      if (/^"use client";|lib\/context\.tsx|\buse[A-Z]\w*\(|createContext/m.test(text)) {
        offending.push(file);
      }
      const statements = text.match(/^(?:import|export)\b[^;]*?\bfrom\s+"[^"]+";/gms) ?? [];
      for (const statement of statements) {
        if (/^(?:import|export)\s+type\b/.test(statement)) continue;
        const target = /from\s+"(\.[^"]+\.tsx?)"/.exec(statement)?.[1];
        if (target) visit(resolve(dirname(file), target));
      }
    };
    visit(join(root, "static.ts"));
    expect(offending).toEqual([]);
    expect([...visited].map((file) => file.slice(process.cwd().length + 1)).sort()).toEqual(
      expect.arrayContaining([
        "src/Button/button-class.ts",
        "src/ConsentBanner/ConsentBannerStatic.tsx",
        "src/ConsentBanner/consent.ts",
        "src/Icon/Icon.tsx",
        "src/Link/link-class.ts",
      ]),
    );
    expect(visited.has(join(root, "ConsentBanner.tsx"))).toBe(false);
    expect(Object.keys(entry).sort()).toEqual(["ConsentBannerStatic", "sendsGlobalPrivacyControl"]);
  });

  it("renders on the server to plain forms that post the choice", () => {
    const html = renderToStaticMarkup(<ConsentBannerStatic {...COPY} />);
    expect(html.match(/<form /g)).toHaveLength(2);
    expect(html.match(/action="\/consent"/g)).toHaveLength(2);
    const buttons = html.match(/<button [^>]*>/g) ?? [];
    const posts = (value: string): number =>
      buttons.filter((b) => b.includes('name="choice"') && b.includes(`value="${value}"`)).length;
    expect(posts("all")).toBe(1);
    expect(posts("none")).toBe(1);
    expect(buttons.every((b) => b.includes('type="submit"'))).toBe(true);
    expect(html).toContain('<input type="hidden" name="choice" value="save"/>');
    const boxes = (html.match(/<input [^>]*>/g) ?? []).filter((i) => i.includes('type="checkbox"'));
    expect(boxes.map((box) => /name="([^"]+)"/.exec(box)?.[1])).toEqual([
      "preferences",
      "analytics_storage",
    ]);
    expect(boxes.some((box) => box.includes("checked"))).toBe(false);
  });
});

describe("ConsentBannerStatic keeps the choices equal", () => {
  it("Accept and Reject are the same element, class, type and form, side by side", () => {
    render(<ConsentBannerStatic {...COPY} />);
    const accept = screen.getByRole("button", { name: "Accept all" });
    const reject = screen.getByRole("button", { name: "Reject all" });
    expect(accept.className).toBe(reject.className);
    expect(accept.className).toBe(buttonClass("secondary", "lg"));
    expect(accept.tagName).toBe(reject.tagName);
    expect(accept.getAttribute("type")).toBe("submit");
    expect(reject.getAttribute("type")).toBe("submit");
    expect(accept.parentElement).toBe(reject.parentElement);
    expect(accept.nextElementSibling).toBe(reject);
    expect(document.activeElement).toBe(document.body);
  });

  it("ticks no category and keeps Choose closed", () => {
    const { container } = render(<ConsentBannerStatic {...COPY} />);
    const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(2);
    expect(boxes.some((box) => box.checked || box.defaultChecked)).toBe(false);
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  it("is a labelled region that passes axe", async () => {
    const { container } = render(<ConsentBannerStatic {...COPY} />);
    expect(screen.getByRole("region", { name: "Cookies" })).toBeTruthy();
    await expectAccessible(container);
  });
});

describe("ConsentBannerStatic links and the privacy signal", () => {
  it("draws plain anchors in the library's link style, or the app's link", () => {
    const { container, rerender } = render(<ConsentBannerStatic {...COPY} />);
    const anchors = [...container.querySelectorAll("a")];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual([
      "/legal/cookie-policy",
      "/legal/cookie-settings",
    ]);
    expect(anchors.every((a) => a.className === linkClass)).toBe(true);
    rerender(
      <ConsentBannerStatic
        {...COPY}
        renderLink={(link, className) => (
          <a href={link.href} className={className} data-router="">
            {link.label}
          </a>
        )}
      />,
    );
    expect(container.querySelectorAll("a[data-router]")).toHaveLength(2);
  });

  it("under Global Privacy Control shows the confirmation and no choices", () => {
    const { container } = render(
      <ConsentBannerStatic {...COPY} gpc gpcLabel="Opt-Out Request Honored" />,
    );
    expect(screen.getByRole("status").textContent).toBe("Opt-Out Request Honored");
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

const screenBarClasses = (): string[] => {
  const html = renderToStaticMarkup(<ConsentBannerStatic {...COPY} />);
  return /<section[^>]*class="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? [];
};

describe("ConsentBannerStatic is a bar at the bottom edge", () => {
  const BAR = [
    "sticky",
    "bottom-0",
    "order-last",
    "mt-auto",
    "z-header",
    "max-h-(--ui-consent-bar-max)",
    "overflow-y-auto",
    "border-t",
    "shadow-menu",
    "pb-[calc(var(--space-16)+env(safe-area-inset-bottom))]",
    "px-[max(var(--space-16),env(safe-area-inset-left),env(safe-area-inset-right))]",
    "print:hidden",
  ];

  it("sticks to the bottom, full width, with a top border, its own scroll and the safe areas", () => {
    const { container } = render(<ConsentBannerStatic {...COPY} />);
    const bar = screen.getByRole("region", { name: "Cookies" });
    expect(bar.hasAttribute("data-xos-consent-bar")).toBe(true);
    const classes = bar.className.split(" ");
    expect(classes).toEqual(expect.arrayContaining(BAR));
    expect(classes).not.toContain("border-b");
    expect(classes.some((c) => /^(?:fixed|absolute|w-|max-w-)/.test(c))).toBe(false);
    // First in the DOM, so keyboard and screen reader users reach it before the page.
    expect(container.firstElementChild).toBe(bar);
  });

  it("draws the privacy signal confirmation in the same bar", () => {
    render(<ConsentBannerStatic {...COPY} gpc gpcLabel="Opt-Out Request Honored" />);
    const bar = screen.getByRole("region", { name: "Cookies" });
    expect(bar.hasAttribute("data-xos-consent-bar")).toBe(true);
    expect(bar.className.split(" ")).toEqual(expect.arrayContaining(BAR));
  });

  it("makes its parent a column so it is drawn last and holds its own height at the end", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/base.css"), "utf8");
    const rule = /:where\(\*\):has\(> \[data-xos-consent-bar\]\) \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("display: flex;");
    expect(rule).toContain("flex-direction: column;");
    expect(rule).toContain("min-block-size: 100dvh;");
  });

  it("shares the viewport with a one-viewport app shell instead of covering its bottom", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/base.css"), "utf8");
    const body = (selector: string): string => {
      const at = css.indexOf(`${selector} {`);
      return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
    };
    expect(body(":where(*):has(> [data-xos-consent-bar]):has(> [data-xos-viewport])")).toContain(
      "block-size: 100dvh;",
    );
    const shell = body(":where(*):has(> [data-xos-consent-bar]) > [data-xos-viewport]");
    expect(shell).toContain("flex: 1 1 0;");
    expect(shell).toContain("min-block-size: 0;");
    expect(body(":where(*):has(> [data-xos-viewport]) > [data-xos-consent-bar]")).toContain(
      "max-block-size: var(--ui-consent-bar-shell-max);",
    );
    expect(css).toContain(
      "--ui-consent-bar-shell-max: max(calc(100dvh - var(--ui-shell-min)), 30dvh);",
    );
  });

  it("keeps keyboard focus above the bar's tallest height, with the phone tab bar added (2.4.11)", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/base.css"), "utf8");
    const body = (selector: string): string => {
      const at = css.indexOf(`${selector} {`);
      return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
    };
    // The scroll padding is the bar's cap, the same token its max height reads.
    expect(css).toContain("--ui-consent-bar-max: 60dvh;");
    expect(screenBarClasses()).toContain("max-h-(--ui-consent-bar-max)");
    expect(body("html:has([data-xos-consent-bar])")).toContain(
      "scroll-padding-bottom: calc(var(--ui-consent-bar-max) + var(--space-16));",
    );
    // With the tab bar on a phone (A23-001) the two add up, and this rule comes after the tab bar's
    // own, with a higher specificity, so it wins wherever both are present.
    const both = "html:has([data-xos-consent-bar]):has([data-xos-bottom-bar])";
    expect(body(both)).toContain(
      "scroll-padding-bottom: calc(var(--ui-consent-bar-max) + var(--ui-bottom-bar) + var(--space-16));",
    );
    expect(css.indexOf(both)).toBeGreaterThan(css.indexOf("html:has([data-xos-bottom-bar]),"));
    const media = css.lastIndexOf("@media (width < 48rem)", css.indexOf(both));
    expect(css.slice(media, css.indexOf(both))).not.toContain("}\n}");
  });

  it("sits over the page and the sidebar and under every overlay on the z-index scale", () => {
    const tokens = JSON.parse(
      readFileSync(join(process.cwd(), "../tokens/xos.tokens.json"), "utf8"),
    ) as { zIndex: { tokens: { name: string; value: string }[] } };
    const z = (name: string): number =>
      Number(tokens.zIndex.tokens.find((token) => token.name === name)?.value);
    const bar = z("z-header");
    for (const below of ["z-base", "z-sticky", "z-sidebar"]) expect(bar).toBeGreaterThan(z(below));
    for (const above of ["z-dropdown", "z-popover", "z-peek", "z-dialog", "z-toast", "z-tooltip"]) {
      expect(bar).toBeLessThan(z(above));
    }
  });
});
