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
