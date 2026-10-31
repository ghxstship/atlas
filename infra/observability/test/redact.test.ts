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
    "ticket",
    "p_ticket",
    "downloadTicket",
    "access_code",
    "p_access_code",
    "accessCode",
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
    "ticket_id",
    "support_ticket_id",
    "ticket_class",
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

  // A69-008: request logs keep the path, and bearer links carry their token in it.
  it("replaces the tokens of bearer links, in paths too", () => {
    const hex = "a".repeat(64);
    for (const prefix of ["xadv", "xagr", "xcal", "xdoc", "xinv", "xlnk", "xos_scim"]) {
      expect(redactString(`${prefix}_${hex}`), prefix).toBe("[token]");
    }
    expect(redactUrl(`/advance/xadv_${hex}?code=1`)).toBe("/advance/[token]");
    expect(redactUrl(`/sign/xdoc_${hex}`)).toBe("/sign/[token]");
    expect(redactUrl(`/auth/invite/xinv_${hex}`)).toBe("/auth/invite/[token]");
    expect(redactString("xadv_short")).toBe("xadv_short");
  });

  // A69-012: share links carry their token in the path, the file route trades it for a download
  // ticket, and kiosk keys, subprocessor notice links and personal access tokens share the shape.
  it("replaces share link tokens, download tickets and the other prefixed secrets", () => {
    const hex = "d".repeat(64);
    for (const prefix of [
      "xshr",
      "xdlt",
      "xkio",
      "xspn",
      "xspu",
      "xos_pat",
      "xshv",
      "xscr",
      "xlgr",
      "xlch",
      "xscl",
      "xcgr",
      "xcch",
    ]) {
      expect(redactString(`${prefix}_${hex}`), prefix).toBe("[token]");
      expect(redactString(`${prefix.toUpperCase()}_${hex.toUpperCase()}`), prefix).toBe("[token]");
    }
    expect(redactUrl(`/share/xshr_${hex}`)).toBe("/share/[token]");
    expect(redactUrl(`/share/xshr_${hex}/file?reason=share_link_invalid`)).toBe(
      "/share/[token]/file",
    );
    expect(redactString(`POST https://atlas.example.test/share/xshr_${hex}/file 303`)).toBe(
      "POST https://atlas.example.test/share/[token]/file 303",
    );
    expect(redactString(`file-download: {"ticket":"xdlt_${hex}"}`)).toBe(
      'file-download: {"ticket":"[token]"}',
    );
    expect(redactString(`https://atlas.example.test/legal/subprocessors?confirm=xspn_${hex}`)).toBe(
      "https://atlas.example.test/legal/subprocessors?confirm=[token]",
    );
    expect(redactString("GET /share/xshr_MISTYPED-or-truncated 404")).toBe(
      "GET /share/[token] 404",
    );
    expect(redactUrl("/share/abc")).toBe("/share/[token]");
    // P1 (ADR 0130): live links, their open handler, device grants and channel keys.
    expect(redactUrl(`/share/view/xshv_${hex}`)).toBe("/share/view/[token]");
    expect(redactUrl(`/share/screen/xscr_${hex}/open?reason=live_link_access_code`)).toBe(
      "/share/screen/[token]/open",
    );
    expect(redactString(`POST https://atlas.example.test/share/view/xshv_${hex}/open 303`)).toBe(
      "POST https://atlas.example.test/share/view/[token]/open 303",
    );
    expect(redactString("GET /share/screen/xscr_truncated 200")).toBe(
      "GET /share/screen/[token] 200",
    );
    expect(redactString(`Set-Cookie: xos_link_grant=xlgr_${hex}; HttpOnly`)).toBe(
      "Set-Cookie: xos_link_grant=[token]; HttpOnly",
    );
    expect(redactString(`realtime join xlink:xlch_${hex}`)).toBe("realtime join xlink:[token]");
    // B3 (ADR 0142): showcaller links, their open handler and clock, device grants and channel keys.
    expect(redactUrl(`/share/showcaller/xscl_${hex}`)).toBe("/share/showcaller/[token]");
    expect(redactUrl(`/share/showcaller/xscl_${hex}/open?reason=showcaller_link_access_code`)).toBe(
      "/share/showcaller/[token]/open",
    );
    expect(redactUrl(`/share/showcaller/xscl_${hex}/clock`)).toBe(
      "/share/showcaller/[token]/clock",
    );
    expect(redactString("POST /share/showcaller/MISTYPED-token 303")).toBe(
      "POST /share/showcaller/[token] 303",
    );
    expect(redactString(`Set-Cookie: xos_showcaller_grant=xcgr_${hex}; HttpOnly`)).toBe(
      "Set-Cookie: xos_showcaller_grant=[token]; HttpOnly",
    );
    expect(redactString(`realtime join xcall:xcch_${hex}`)).toBe("realtime join xcall:[token]");
    expect(redactString("/share/")).toBe("/share/");
    expect(redactString("at /usr/share/zoneinfo/UTC")).toBe("at /usr/share/zoneinfo/UTC");
    expect(redactString("at file:///usr/share/nodejs/undici/index.js:12:3")).toBe(
      "at file:///usr/share/nodejs/undici/index.js:12:3",
    );
    // After a percent escape: Next's encoded router state header and a sign-in redirect.
    const tree = encodeURIComponent(
      JSON.stringify([
        "",
        { children: ["share", { children: [["token", `xshr_${hex}`, "d", null], {}] }] },
      ]),
    );
    expect(redactString(tree)).not.toContain(hex);
    expect(redactString(`/auth/mfa?next=%2Fshare%2Fxshr_${hex}%2Ffile`)).toBe(
      "/auth/mfa?next=%2Fshare%2F[token]%2Ffile",
    );
    expect(redactString(`next=%252Fshare%252Fxshr_${hex}`)).toBe("next=%252Fshare%252F[token]");
    expect(redactString("GET /files/share/new 200")).toBe("GET /files/share/new 200");
    expect(redactString("?ticket=abc&access_code=123456")).toBe(
      `?ticket=${REDACTED}&access_code=${REDACTED}`,
    );
    expect(
      redact({ p_token: `xshr_${hex}`, p_access_code: "123456", p_ticket: "xdlt_short" }),
    ).toEqual({ p_token: REDACTED, p_access_code: REDACTED, p_ticket: REDACTED });
  });

  // A84: calendar feed links and signed reply addresses.
  it("replaces whatever follows /ical/, and signed reply addresses", () => {
    const hex = "b".repeat(64);
    expect(redactUrl(`/ical/xcal_${hex}.ics`)).toBe("/ical/[token]");
    expect(redactString(`GET https://atlas.example.test/ical/xcal_${hex}.ics 200`)).toBe(
      "GET https://atlas.example.test/ical/[token] 200",
    );
    expect(redactString("GET /ical/XCAL_TRUNCATED.ics 404")).toBe("GET /ical/[token] 404");
    expect(redactString(`webcal://atlas.example.test/ical/${"c".repeat(20)}`)).toBe(
      "webcal://atlas.example.test/ical/[token]",
    );
    expect(redactString("/ical/")).toBe("/ical/");
    const reply = `r-${"1".repeat(32)}-${"2".repeat(32)}-${"3".repeat(32)}`;
    expect(redactString(`local part ${reply}`)).toBe("local part [token]");
    expect(redact({ to: `${reply}@inbound.example.test` })).toEqual({
      to: "[token]@inbound.example.test",
    });
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

  // The quadratic email rule took about 21 s on these inputs; linear rules take milliseconds. The bound leaves
  // room for a loaded CI runner (314 ms once against the first bound of 250).
  it("stays linear on long runs that look almost like a match", () => {
    const started = performance.now();
    redactString("deadbeef".repeat(8000), 100);
    redactString(`${"a/".repeat(16000)}/share/x`, 100);
    redactString("/".repeat(64000), 100);
    expect(performance.now() - started).toBeLessThan(3000);
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
