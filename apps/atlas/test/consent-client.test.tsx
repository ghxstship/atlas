import { readFileSync } from "node:fs";
import enUS from "@xos/i18n/messages/en-US/compliance.json" with { type: "json" };
import esUS from "@xos/i18n/messages/es-US/compliance.json" with { type: "json" };
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RoutedConsentBanner } from "@/components/privacy/consent-banner-routed";
import { RoutedConsentSettings } from "@/components/privacy/consent-settings-client";

/**
 * Atlas's wiring of the shared cookie banner (issue 107): the links are next/link, so the Cookie
 * Policy and Cookie settings open without a full page load, and a Global Privacy Control signal
 * only the browser reports is confirmed in Atlas's own words, never as a message key.
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
      <RoutedConsentBanner
        title="Cookies"
        body="We use cookies."
        policy={{ label: "Cookie Policy", href: "/legal/cookie-policy" }}
        settings={{ label: "Cookie settings", href: "/legal/cookie-settings" }}
        acceptLabel="Accept all"
        rejectLabel="Reject all"
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

describe("the Global Privacy Control confirmation in the Atlas banner", () => {
  const source = (file: string): string =>
    readFileSync(new URL(`../components/privacy/${file}`, import.meta.url), "utf8");

  it("has a banner sentence in both launch languages that names no choices below", () => {
    for (const catalog of [enUS, esUS]) {
      const text = catalog.cookies.gpcBanner;
      expect(text).toContain("Global Privacy Control");
      expect(text).not.toMatch(/below|abajo/);
      expect(catalog.cookies.gpc.startsWith(text.slice(0, -1))).toBe(true);
    }
  });

  it("is passed to the banner, and the settings page keeps its own sentence", () => {
    expect(source("consent-banner.tsx")).toContain('gpcLabel={t("gpcBanner")}');
    expect(source("consent-settings.tsx")).toContain('gpcNotice={t("gpc")}');
  });

  it("is what the banner shows under the signal, in place of the choices", () => {
    const html = renderToStaticMarkup(
      <RoutedConsentBanner
        title="Cookies"
        acceptLabel="Accept all"
        gpc
        gpcLabel={enUS.cookies.gpcBanner}
      />,
    );
    expect(html).toContain(enUS.cookies.gpcBanner);
    expect(html).not.toContain("mk.consent.gpc");
    expect(html).not.toContain("Accept all");
  });
});
