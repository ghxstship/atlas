import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DOCUMENT_KINDS } from "@xos/data/documents/model";
import { describe, expect, it } from "vitest";
import { atlasRecordPath, documentHref } from "@/lib/documents/links";

const app = fileURLToPath(new URL("../app/[org]/", import.meta.url));

describe("generated document links (Section 11.9)", () => {
  it("serves every document from the org's documents route", () => {
    expect(documentHref("acme", "purchase-order", "po 1")).toBe(
      "/acme/documents/purchase-order/po%201",
    );
    expect(existsSync(`${app}documents/[kind]/[id]/route.ts`)).toBe(true);
  });

  it.each(DOCUMENT_KINDS)("links the %s QR code to an Atlas page that exists", (kind) => {
    const path = atlasRecordPath("acme", kind, {
      id: "id-1",
      recordKey: "NWF26-7",
      projectKey: "NWF26",
    });
    expect(path.startsWith("/acme/")).toBe(true);
    const [route] = path.slice("/acme/".length).split("?");
    expect(existsSync(`${app}${route}/page.tsx`), route).toBe(true);
    expect(path).toMatch(/\?(peek|project)=/);
  });

  it("opens a BEO by its key and the final cost report by its project", () => {
    expect(
      atlasRecordPath("acme", "beo", { id: "x", recordKey: "NWF26-7", projectKey: null }),
    ).toBe("/acme/hospitality/beos?peek=NWF26-7");
    expect(
      atlasRecordPath("acme", "final-cost-report", {
        id: "p",
        recordKey: "k",
        projectKey: "NWF26",
      }),
    ).toBe("/acme/reports/final-cost-report?project=NWF26");
  });

  it("has no page of its own under the org, only the route handler", () => {
    expect(readdirSync(`${app}documents/[kind]/[id]`)).toEqual(["route.ts"]);
  });
});
