import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LEGAL_TEXT } from "@/lib/legal-text.generated";
import { LEGAL_DOCUMENTS } from "@/lib/legal.generated";

/**
 * /legal (crawl 4.9): trimming a document's address lands on a list of every public document Atlas serves, each
 * linked with its version, and Cookie settings, instead of a 404. Internal documents never appear.
 */
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, values?: Record<string, string>) =>
    `[${key}${values?.["version"] ? ` ${values["version"]}` : ""}]`,
  getFormatter: async () => ({ dateTime: (d: Date) => d.toISOString().slice(0, 10) }),
}));

const { default: LegalIndexPage } = await import("../app/legal/page");

describe("the legal index", () => {
  it("links every public document Atlas serves, with its version, and Cookie settings", async () => {
    const html = renderToStaticMarkup(await LegalIndexPage());
    const hrefs = [...html.matchAll(/<a [^>]*href="(\/legal\/[^"]+)"/g)].map((m) => m[1]);
    const served = LEGAL_DOCUMENTS.filter(
      (d) => d.publish === "public" && LEGAL_TEXT[d.slug] !== undefined,
    );
    expect(served.length).toBeGreaterThan(5);
    expect(hrefs).toEqual([...served.map((d) => `/legal/${d.slug}`), "/legal/cookie-settings"]);
    for (const d of served) expect(html).toContain(` ${d.version}]`);
    for (const d of LEGAL_DOCUMENTS.filter((x) => x.publish !== "public")) {
      expect(hrefs).not.toContain(`/legal/${d.slug}`);
    }
    expect(html).toContain("<h1");
  });
});
