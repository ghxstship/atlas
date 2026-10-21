import { describe, expect, it } from "vitest";
import { placeFrom, requestDevice } from "../src/session-device.ts";

const headers = (values: Record<string, string>) => new Headers(values);

describe("the device behind a request (A99, migration 1561)", () => {
  it("reads the address the trusted proxy appended, never the client's first entry", () => {
    const device = requestDevice(
      headers({ "x-forwarded-for": "203.0.113.9, 198.51.100.7", "user-agent": "Mozilla/5.0" }),
      {},
    );
    expect(device).toEqual({
      clientAddress: "198.51.100.7",
      place: null,
      userAgent: "Mozilla/5.0",
    });
  });

  it("names a place only from Vercel's own headers, with no proxy in front of it", () => {
    const geo = headers({
      "x-vercel-ip-city": "S%C3%A3o%20Paulo",
      "x-vercel-ip-country-region": "SP",
      "x-vercel-ip-country": "BR",
    });
    expect(placeFrom(geo, { onVercel: true, trustedHops: 0 })).toBe("São Paulo, SP, BR");
    expect(placeFrom(geo, { onVercel: false, trustedHops: 0 })).toBeNull();
    expect(placeFrom(geo, { onVercel: true, trustedHops: 1 })).toBeNull();
    expect(requestDevice(geo, { VERCEL: "1" }).place).toBe("São Paulo, SP, BR");
  });

  it("drops malformed or control-character places and empty agents", () => {
    expect(
      placeFrom(headers({ "x-vercel-ip-city": "%E0%A4%A" }), { onVercel: true, trustedHops: 0 }),
    ).toBeNull();
    expect(
      placeFrom(headers({ "x-vercel-ip-city": "Lisbon%0A" }), { onVercel: true, trustedHops: 0 }),
    ).toBe("Lisbon");
    expect(
      placeFrom(headers({ "x-vercel-ip-city": "A%01B" }), { onVercel: true, trustedHops: 0 }),
    ).toBeNull();
    expect(requestDevice(headers({ "user-agent": "  " }), {}).userAgent).toBeNull();
  });
});
