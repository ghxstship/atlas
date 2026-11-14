import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConsentBannerStatic } from "@xos/ui/consent/static";
import { routerLink } from "@/components/privacy/consent-link";
import { RoutedConsentSettings } from "@/components/privacy/consent-settings-client";

/**
 * Atlas's wiring of the shared cookie banner (issue 107): the links are next/link, so the Cookie
 * Policy and Cookie settings open without a full page load, and the banner on every route is the
 * script-free one, a server component with no client module of its own.
 */

vi.mock("next/link", () => ({
  default: ({
    href,
    className,
    children,
  }: {
    href: string;
    className: string;
    children: ReactNode;
  }) => (
    <a href={href} className={className} data-next-link="">
      {children}
    </a>
  ),
}));

/** The class the package's own Link draws with (packages/ui/src/Link/Link.tsx). */
const linkClass =
  "xos-hit inline-flex items-center gap-2 font-medium text-accent-text no-underline hover:underline hover:underline-offset-(length:--space-2)";

const links = (html: string): string[] => html.match(/<a [^>]*>[^<]*<\/a>/g) ?? [];

describe("the consent links in Atlas", () => {
  it("are next/link in the banner, with the library's link style", () => {
    const html = renderToStaticMarkup(
      <ConsentBannerStatic
        title="Cookies"
        body="We use cookies."
        policy={{ label: "Cookie Policy", href: "/legal/cookie-policy" }}
        settings={{ label: "Cookie settings", href: "/legal/cookie-settings" }}
        acceptLabel="Accept all"
        rejectLabel="Reject all"
        action="/consent"
        renderLink={routerLink}
      />,
    );
    expect(links(html)).toEqual([
      `<a href="/legal/cookie-policy" class="${linkClass}" data-next-link="">Cookie Policy</a>`,
      `<a href="/legal/cookie-settings" class="${linkClass}" data-next-link="">Cookie settings</a>`,
    ]);
  });

  it("are next/link on Cookie settings", () => {
    const html = renderToStaticMarkup(
      <RoutedConsentSettings
        title="Cookie settings"
        status="You have not chosen yet."
        categoriesLabel="Categories"
        necessary="Strictly necessary."
        categories={[]}
        saveLabel="Save choices"
        acceptLabel="Accept all"
        rejectLabel="Reject all"
        policy={{ label: "Cookie Policy", href: "/legal/cookie-policy" }}
      />,
    );
    expect(links(html)).toEqual([
      `<a href="/legal/cookie-policy" class="${linkClass}" data-next-link="">Cookie Policy</a>`,
    ]);
  });
});

describe("the banner on every Atlas route", () => {
  const source = (file: string): string =>
    readFileSync(new URL(`../components/privacy/${file}`, import.meta.url), "utf8");

  it("is the script-free banner, rendered by a server component", () => {
    const banner = source("consent-banner.tsx");
    expect(banner).toContain('from "@xos/ui/consent/static"');
    expect(banner).not.toContain('"use client"');
    expect(banner).not.toMatch(/from "@xos\/ui\/consent"|from "@xos\/ui"/);
    expect(source("consent-link.tsx")).not.toContain('"use client"');
  });
});
