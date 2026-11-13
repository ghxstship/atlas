import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The age refusal page (ADR 0156) ends the session, so it must not be a dead end (crawl 4.9): every outcome links
 * home, the Privacy Policy and the Legal Contact page, and none offers the age question again.
 */
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => `[${key}]`,
}));

const { default: AgeRefusedPage } = await import("../app/auth/age-refused/page");

async function page(outcome?: string): Promise<string> {
  const element = await AgeRefusedPage({
    searchParams: Promise.resolve(outcome === undefined ? {} : { outcome }),
  } as Parameters<typeof AgeRefusedPage>[0]);
  return renderToStaticMarkup(element);
}

describe("the age refusal page", () => {
  it.each([undefined, "closed", "held"])("links on from outcome %s", async (outcome) => {
    const html = await page(outcome);
    const hrefs = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/", "/legal/privacy-policy", "/legal/contact"]);
    expect(html).toContain('aria-label="[linksLabel]"');
    expect(html).not.toMatch(/sign-up|age-question/);
  });
});
