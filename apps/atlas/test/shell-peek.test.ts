import { getMessages, locales } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import { pageOwnsPeek, peekHref, shellPeekMode } from "../lib/shell/peek";

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

  it("opens a ?peek key on other pages and waits for a collection page to claim it", () => {
    const at = (search: string) => new URLSearchParams(search);
    expect(shellPeekMode("/demo-productions/home", at("peek=NWS-12"))).toBe("open");
    expect(shellPeekMode("/demo-productions/r/NWS-12", at("peek=NWS-7&tab=mine"))).toBe("open");
    expect(shellPeekMode("/demo-productions/vendors/directory", at("peek=NWS-12"))).toBe("claim");
    expect(shellPeekMode("/demo-productions/home", at("tab=mine"))).toBe("none");
    expect(shellPeekMode("/demo-productions/home", at("peek="))).toBe("none");
  });

  it("never opens on a collection's full record page, which renders the row itself", () => {
    const id = "0192f1e2-7c3a-7b4d-9e8f-0000000000aa";
    for (const path of [
      "/demo-productions/vendors/directory",
      "/demo-productions/assets/units",
      "/demo-productions/logistics/shipments",
      "/demo-productions/views/0192f1e2-7c3a-7b4d-9e8f-000000000001",
    ]) {
      expect(shellPeekMode(path, new URLSearchParams(`peek=${id}&full=1`)), path).toBe("none");
      expect(shellPeekMode(path, new URLSearchParams(`view=board&full=1&peek=${id}`)), path).toBe(
        "none",
      );
    }
    // The full-page flag belongs to collections: elsewhere the shell still opens the record.
    expect(shellPeekMode("/demo-productions/home", new URLSearchParams("peek=NWS-12&full=1"))).toBe(
      "open",
    );
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
