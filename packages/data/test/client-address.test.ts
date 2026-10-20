import { describe, expect, it } from "vitest";
import { clientAddress, trustedProxyHops } from "../src/client-address.ts";

// A69-003: proxies append the address they saw; the first X-Forwarded-For entry is the client's own text.
describe("clientAddress", () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it("takes the entry the trusted proxy appended, never the first one", () => {
    expect(clientAddress(headers({ "x-forwarded-for": "203.0.113.40, 198.51.100.9" }))).toBe(
      "198.51.100.9",
    );
    expect(clientAddress(headers({ "x-forwarded-for": " 198.51.100.10 " }))).toBe("198.51.100.10");
    expect(clientAddress(headers({ "x-forwarded-for": "203.0.113.40,, 198.51.100.11 ," }))).toBe(
      "198.51.100.11",
    );
  });

  it("counts further trusted proxies from the right and refuses a chain that skipped one", () => {
    const chain = headers({ "x-forwarded-for": "203.0.113.40, 198.51.100.12, 10.0.0.4" });
    expect(clientAddress(chain, 1)).toBe("198.51.100.12");
    expect(clientAddress(chain, 2)).toBe("203.0.113.40");
    expect(clientAddress(chain, 3)).toBeNull();
  });

  it("uses X-Real-IP only when no chain was sent", () => {
    expect(clientAddress(headers({ "x-real-ip": "198.51.100.13" }))).toBe("198.51.100.13");
    expect(
      clientAddress(headers({ "x-real-ip": "203.0.113.40", "x-forwarded-for": "198.51.100.14" })),
    ).toBe("198.51.100.14");
    expect(clientAddress(headers({}))).toBeNull();
    expect(clientAddress(headers({ "x-real-ip": "  " }))).toBeNull();
  });

  it("reads the hop count from the environment value", () => {
    expect(trustedProxyHops(undefined)).toBe(0);
    expect(trustedProxyHops("")).toBe(0);
    expect(trustedProxyHops(" 2 ")).toBe(2);
    expect(trustedProxyHops("-1")).toBe(0);
    expect(trustedProxyHops("many")).toBe(0);
    expect(trustedProxyHops("100")).toBe(0);
  });
});
