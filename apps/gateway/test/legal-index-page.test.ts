import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_LEGAL_DOCUMENTS } from "@/lib/auth/legal";

/**
 * /legal (crawl 4.9): trimming a document's address lands on the documents Gateway serves, each linked with its
 * version, Cookie settings, and Atlas's legal page for the rest, instead of a 404.
 */
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, values?: Record<string, string>) =>
    `[${key}${values?.["version"] ? ` ${values["version"]}` : ""}]`,
  getFormatter: async () => ({ dateTime: (d: Date) => d.toISOString().slice(0, 10) }),
}));

const { default: LegalIndexPage } = await import("../app/(public)/legal/page");

describe("the legal index", () => {
  it("links every document Gateway serves, Cookie settings and Atlas's legal page", async () => {
    const html = renderToStaticMarkup(await LegalIndexPage());
    const hrefs = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([
      ...GATEWAY_LEGAL_DOCUMENTS.map((d) => `/legal/${d.slug}`),
      "/legal/cookie-settings",
      "https://atlas.ghxstship.tech/legal",
    ]);
    for (const d of GATEWAY_LEGAL_DOCUMENTS) expect(html).toContain(` ${d.version}]`);
  });
});
