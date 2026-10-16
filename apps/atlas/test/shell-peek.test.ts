import { getMessages, locales } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import { pageOwnsPeek, peekHref } from "../lib/shell/peek";

describe("the shell's global ?peek hook", () => {
  it("opens a record on pages that do not peek their own rows", () => {
    for (const path of [
      "/demo-productions/home",
      "/demo-productions/activity",
      "/demo-productions/r/NWS-12",
      "/demo-productions/p/NWS/overview",
    ]) {
      expect(pageOwnsPeek(path), path).toBe(false);
    }
  });

  it("leaves ?peek to collection pages and saved views, which peek their own rows", () => {
    for (const path of [
      "/demo-productions/logistics/shipments",
      "/demo-productions/work/all-records",
      "/demo-productions/assets/units",
      "/demo-productions/views/0192f1e2-7c3a-7b4d-9e8f-000000000001",
    ]) {
      expect(pageOwnsPeek(path), path).toBe(true);
    }
  });

  it("builds citation links: a peek where the shell opens it, else the record page", () => {
    expect(peekHref("demo-productions", "/demo-productions/home", "tab=mine", "NWS-12")).toBe(
      "/demo-productions/home?tab=mine&peek=NWS-12",
    );
    expect(
      peekHref("demo-productions", "/demo-productions/home", "peek=NWS-1&full=1", "NWS-12"),
    ).toBe("/demo-productions/home?peek=NWS-12");
    expect(
      peekHref("demo-productions", "/demo-productions/logistics/shipments", "", "NWS-12"),
    ).toBe("/demo-productions/r/NWS-12");
  });

  it("has the peek copy in every locale", () => {
    for (const locale of locales) {
      const peek = getMessages(locale).peek;
      expect(peek.missing).toContain("{key}");
      expect(peek.close.length).toBeGreaterThan(0);
    }
  });
});
