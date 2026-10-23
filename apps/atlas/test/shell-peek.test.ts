import { getMessages, locales } from "@xos/i18n";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { pageOwnsPeek, peekHref, shellOpensPeek, shellPeekMode } from "../lib/shell/peek";
import {
  handOffPeek,
  peekHandoffs,
  serverPeekHandoffs,
  subscribePeekHandoffs,
  unshownPeekKey,
} from "../lib/shell/peek-handoff";

const at = (search: string) => new URLSearchParams(search);

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

  it("opens a record on lists that open no peek of their own", () => {
    for (const path of [
      "/demo-productions/inbox",
      "/demo-productions/approvals",
      "/demo-productions/trash",
      "/demo-productions/activity/audit-log",
      "/demo-productions/opportunities/pipeline",
      "/demo-productions/p/NWS/engagements",
    ]) {
      expect(pageOwnsPeek(path), path).toBe(false);
      expect(shellPeekMode(path, at("peek=NWS-12")), path).toBe("open");
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

  it("opens a ?peek key on other pages and leaves it to a collection page to hand over", () => {
    expect(shellPeekMode("/demo-productions/home", at("peek=NWS-12"))).toBe("open");
    expect(shellPeekMode("/demo-productions/r/NWS-12", at("peek=NWS-7&tab=mine"))).toBe("open");
    expect(shellPeekMode("/demo-productions/vendors/directory", at("peek=NWS-12"))).toBe("handoff");
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

  it("opens on a collection page only a key the page hands over, on that page", () => {
    const vendors = "/demo-productions/vendors/directory";
    const id = "0192f1e2-7c3a-7b4d-9e8f-0000000000aa";
    // However long the page's own panel takes, the shell stays closed until the page hands over.
    expect(shellOpensPeek(vendors, at(`peek=${id}`), [])).toBe(false);
    expect(shellOpensPeek(vendors, at(`peek=${id}`), [{ path: vendors, key: id }])).toBe(true);
    // A hand-off of another key, or from another page still on screen, opens nothing.
    expect(shellOpensPeek(vendors, at(`peek=${id}`), [{ path: vendors, key: "NWS-12" }])).toBe(
      false,
    );
    const rfqs = { path: "/demo-productions/procurement/rfqs", key: id };
    expect(shellOpensPeek(vendors, at(`peek=${id}`), [rfqs])).toBe(false);
    // The full page never hands over; other pages open without one; no key opens nothing.
    const handedOver = [{ path: vendors, key: id }];
    expect(shellOpensPeek(vendors, at(`peek=${id}&full=1`), handedOver)).toBe(false);
    expect(shellOpensPeek(vendors, at("view=board"), handedOver)).toBe(false);
    expect(shellOpensPeek("/demo-productions/home", at("peek=NWS-12"), [])).toBe(true);
  });

  it("hands over the key of a collection that rendered no panel for it", () => {
    const panel = createElement("aside", null, "Bayline Audio Rentals");
    expect(unshownPeekKey("NWS-12", null)).toBe("NWS-12");
    expect(unshownPeekKey("NWS-12", undefined)).toBe("NWS-12");
    expect(unshownPeekKey("NWS-12", false)).toBe("NWS-12");
    expect(unshownPeekKey("NWS-12", [null, false, [undefined]])).toBe("NWS-12");
    expect(unshownPeekKey("NWS-12", panel)).toBeNull();
    expect(unshownPeekKey("NWS-12", [null, panel])).toBeNull();
    expect(unshownPeekKey(null, null)).toBeNull();
    expect(unshownPeekKey("", null)).toBeNull();
  });

  it("keeps hand-offs in a store the shell subscribes to until each is released", () => {
    const vendors = { path: "/demo-productions/vendors/directory", key: "NWS-12" };
    let notified = 0;
    const unsubscribe = subscribePeekHandoffs(() => {
      notified += 1;
    });
    const before = peekHandoffs();
    expect(peekHandoffs()).toBe(before);
    const first = handOffPeek(vendors.path, vendors.key);
    const second = handOffPeek(vendors.path, vendors.key);
    expect(peekHandoffs()).toHaveLength(before.length + 2);
    // The same key handed over twice (a re-mount) stays until its last hand-off is released.
    first();
    expect(peekHandoffs()).toContainEqual(vendors);
    second();
    expect(peekHandoffs()).toHaveLength(before.length);
    expect(notified).toBe(4);
    unsubscribe();
    handOffPeek("/demo-productions/home", "NWS-1")();
    expect(notified).toBe(4);
    expect(serverPeekHandoffs()).toEqual([]);
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
