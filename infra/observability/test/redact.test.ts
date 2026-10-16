import { describe, expect, it } from "vitest";
import {
  REDACTED,
  isSensitiveKey,
  redact,
  redactAttributes,
  redactString,
  redactUrl,
} from "../src/redact.ts";

describe("isSensitiveKey", () => {
  it.each([
    "email",
    "contact_email",
    "Authorization",
    "x-api-key",
    "refreshToken",
    "password",
    "phone_number",
    "tax_id",
    "first_name",
    "ip",
    "latitude",
    "cookie",
    "set-cookie",
    "bank_account",
    "date_of_birth",
    "notes",
  ])("treats %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "org_id",
    "person_id",
    "status",
    "ownership",
    "zipper_count",
    "project_name",
    "duration_ms",
    "code",
  ])("keeps %s", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe("redactString", () => {
  it("replaces emails, phones, cards, SSNs and IPs", () => {
    const input =
      "user ada@example.com called +14155550123 and (415) 555-0199 paid 4111 1111 1111 1111 ssn 123-45-6789 from 203.0.113.9";
    expect(redactString(input)).toBe(
      "user [email] called [phone] and [phone] paid [card] ssn [ssn] from [ip]",
    );
  });

  it("replaces credentials", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactString(`token ${jwt}`)).toBe("token [jwt]");
    expect(redactString("Authorization: Bearer abc.def-ghi")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactString("key xos_live_AbC123")).toBe("key [api-key]");
    expect(redactString("stripe sk_test_51Habc")).toBe("stripe [api-key]");
  });

  it("redacts secrets in query strings", () => {
    expect(redactString("GET /auth/callback?code=abc123&next=/home")).toBe(
      `GET /auth/callback?code=${REDACTED}&next=/home`,
    );
  });

  it("keeps UUIDs, ISO timestamps and digits that fail the Luhn check", () => {
    const uuid = "01928f6e-8a1b-7c2d-9e3f-4a5b6c7d8e9f";
    expect(redactString(uuid)).toBe(uuid);
    expect(redactString("at 2026-10-14T10:30:00.000Z")).toBe("at 2026-10-14T10:30:00.000Z");
    expect(redactString("order 1234 5678 9012 3456")).toBe("order 1234 5678 9012 3456");
    expect(redactString("id 12345678-1234-7123-8123-123456789012 ok")).toBe(
      "id 12345678-1234-7123-8123-123456789012 ok",
    );
  });

  it("replaces IPv6 addresses", () => {
    expect(redactString("from 2001:db8:85a3:0:0:8a2e:370:7334")).toBe("from [ip]");
  });

  it("truncates long strings", () => {
    const out = redactString("a".repeat(5000));
    expect(out.startsWith("a".repeat(4096))).toBe(true);
    expect(out.endsWith("[truncated 904]")).toBe(true);
  });
});

describe("redactUrl", () => {
  it("drops the query and fragment", () => {
    expect(redactUrl("/api/v1/projects?email=ada@example.com#x")).toBe("/api/v1/projects");
    expect(redactUrl("/plain")).toBe("/plain");
  });
});

describe("redact", () => {
  it("replaces sensitive keys at every depth without mutating the input", () => {
    const input = {
      org_id: "01928f6e-8a1b-7c2d-9e3f-4a5b6c7d8e9f",
      user: { email: "ada@example.com", profile: { phone: "+14155550123", role: "producer" } },
      list: [{ password: "hunter2" }, "write to bo@example.org"],
      empty: { token: null },
    };
    const out = redact(input) as typeof input;
    expect(out).toEqual({
      org_id: "01928f6e-8a1b-7c2d-9e3f-4a5b6c7d8e9f",
      user: { email: REDACTED, profile: { phone: REDACTED, role: "producer" } },
      list: [{ password: REDACTED }, "write to [email]"],
      empty: { token: null },
    });
    expect(input.user.email).toBe("ada@example.com");
  });

  it("honors allowKeys", () => {
    expect(redact({ notes: "kept" }, { allowKeys: ["notes"] })).toEqual({ notes: "kept" });
  });

  it("handles cycles, depth, errors, dates, maps, sets, binary and functions", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    const error = new Error("failed for ada@example.com", { cause: { email: "x@y.io" } });
    (error as Error & { code: string }).code = "XR001";
    const out = redact(
      {
        cyclic,
        deep: { a: { b: { c: 1 } } },
        error,
        when: new Date("2026-10-14T00:00:00Z"),
        bad: new Date("nope"),
        map: new Map([["email", "a@b.co"]]),
        set: new Set(["a@b.co"]),
        bytes: new Uint8Array(4),
        fn: () => 1,
        big: 10n,
        sym: Symbol("s"),
        url: new URL("https://x.test/p?token=1"),
      },
      { maxDepth: 3 },
    ) as Record<string, unknown>;
    expect(out["cyclic"]).toEqual({ name: "loop", self: "[circular]" });
    expect(out["deep"]).toEqual({ a: { b: "[depth]" } });
    expect(out["error"]).toMatchObject({
      name: "Error",
      message: "failed for [email]",
      code: "XR001",
      cause: { email: REDACTED },
    });
    expect(out["when"]).toBe("2026-10-14T00:00:00.000Z");
    expect(out["bad"]).toBeNull();
    expect(out["map"]).toEqual({ email: REDACTED });
    expect(out["set"]).toEqual(["[email]"]);
    expect(out["bytes"]).toBe("[binary 4 bytes]");
    expect("fn" in out).toBe(false);
    expect(out["big"]).toBe("10");
    expect(out["sym"]).toBe("Symbol(s)");
    expect(out["url"]).toBe("https://x.test/p");
  });

  it("keeps a shared object that is not a cycle", () => {
    const shared = { status: "ok" };
    expect(redact({ a: shared, b: shared })).toEqual({ a: { status: "ok" }, b: { status: "ok" } });
  });
});

describe("redactAttributes", () => {
  it("keeps primitives and primitive arrays and drops other values", () => {
    expect(
      redactAttributes({
        "http.route": "/api/v1/projects",
        "user.email": "ada@example.com",
        count: 3,
        ok: true,
        tags: ["a@b.co", "plain"],
        nums: [1, 2],
        flags: [true],
        nested: { a: 1 },
        mixed: [1, "a"],
        missing: undefined,
        nothing: null,
      }),
    ).toEqual({
      "http.route": "/api/v1/projects",
      "user.email": REDACTED,
      count: 3,
      ok: true,
      tags: ["[email]", "plain"],
      nums: [1, 2],
      flags: [true],
    });
  });

  it("honors allowKeys", () => {
    expect(redactAttributes({ notes: "kept" }, { allowKeys: ["notes"] })).toEqual({
      notes: "kept",
    });
  });
});
