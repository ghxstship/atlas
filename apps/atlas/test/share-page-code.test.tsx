import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../../packages/i18n/messages/en-US/compliance.json";
import es from "../../../packages/i18n/messages/es-US/compliance.json";

/**
 * Every share link requires its access code (migration 6281, ADR 0142), but /share/{token} said "Enter the 6-digit code
 * if you received one with the link" and let an empty form submit (crawl 4.9). The field is required and its help says
 * the code came with the link.
 */
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const { default: SharePage } = await import("@/app/share/[token]/page");

describe("the share link page", () => {
  it("requires the access code", async () => {
    const token = `xshr_${"a".repeat(64)}`;
    const element = await SharePage({
      params: Promise.resolve({ token }),
      searchParams: Promise.resolve({}),
    } as never);
    const html = renderToStaticMarkup(element);
    expect(html).toMatch(/<input[^>]*id="share-access-code"[^>]*required/);
  });

  it("never calls the code optional", () => {
    for (const help of [en.open.accessCodeHelp, es.open.accessCodeHelp]) {
      expect(help).not.toMatch(/if you received|si lo recibiste/i);
    }
  });
});
