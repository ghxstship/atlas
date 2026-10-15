import { describe, expect, it } from "vitest";
import { hrefWith, joined, param } from "../components/operations/query";
import { errorKey } from "../lib/operations/state";
import { instantToLocal, localToInstant } from "../lib/operations/time";

describe("project time zones", () => {
  it("reads a local time in the project's zone, across daylight saving", () => {
    expect(localToInstant("2026-07-04T19:30", "America/New_York")).toBe("2026-07-04T23:30:00.000Z");
    expect(localToInstant("2026-12-04T19:30", "America/New_York")).toBe("2026-12-05T00:30:00.000Z");
    expect(localToInstant("2026-12-04T19:30", "UTC")).toBe("2026-12-04T19:30:00.000Z");
  });

  it("refuses an empty or malformed value", () => {
    expect(localToInstant("", "UTC")).toBeNull();
    expect(localToInstant(undefined, "UTC")).toBeNull();
    expect(localToInstant("2026-13-45T99:99", "UTC")).toBeNull();
    expect(localToInstant("tomorrow", "UTC")).toBeNull();
  });

  it("shows an instant as a local time and round-trips", () => {
    expect(instantToLocal("2026-07-04T23:30:00.000Z", "America/New_York")).toBe("2026-07-04T19:30");
    expect(instantToLocal(null, "UTC")).toBe("");
    expect(instantToLocal("not a date", "UTC")).toBe("");
    const local = "2027-03-12T08:15";
    expect(instantToLocal(localToInstant(local, "Europe/Madrid"), "Europe/Madrid")).toBe(local);
  });
});

describe("refusal copy keys", () => {
  it("names known rules and falls back by kind", () => {
    expect(errorKey({ kind: "refusal", rule: "credential_self_issue", message: "" })).toBe(
      "rules.credential_self_issue",
    );
    expect(errorKey({ kind: "refusal", rule: "something_new", message: "" })).toBe("refused");
    expect(errorKey({ kind: "not-found" })).toBe("notFound");
    expect(errorKey({ kind: "conflict", message: "" })).toBe("conflict");
    expect(errorKey({ kind: "invalid", message: "" })).toBe("invalid");
    expect(errorKey({ kind: "unexpected", message: "" })).toBe("unexpected");
  });
});

describe("collection links", () => {
  it("keeps the query state and replaces what changes", () => {
    const search = { project: "NWS", view: ["table", "list"], peek: "x" };
    expect(hrefWith("/o/credentials/issued", search, { peek: undefined, view: "board" })).toBe(
      "/o/credentials/issued?project=NWS&view=board",
    );
    expect(hrefWith("/o/a", {}, {})).toBe("/o/a");
    expect(param(search, "view")).toBe("table");
    expect(param(search, "missing")).toBeUndefined();
  });

  it("joins present label parts", () => {
    expect(joined("NWS-142", null, "Gate", undefined, "", 3)).toBe("NWS-142 · Gate · 3");
  });
});
