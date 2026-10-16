import { describe, expect, it } from "vitest";
import { parseEnv } from "../lib/env";
import { gatewayUrl } from "../lib/gateway-url";

describe("gatewayUrl", () => {
  it("prefixes the Gateway origin so a token link shows in full", () => {
    expect(gatewayUrl("/advance/tok", { GATEWAY_SITE_URL: "https://gateway.example.test" })).toBe(
      "https://gateway.example.test/advance/tok",
    );
    expect(gatewayUrl("sign/tok", { GATEWAY_SITE_URL: "https://gateway.example.test/" })).toBe(
      "https://gateway.example.test/sign/tok",
    );
  });

  it("falls back to the path when no Gateway origin is configured", () => {
    expect(gatewayUrl("/sign/tok", {})).toBe("/sign/tok");
    expect(gatewayUrl("/sign/tok", { GATEWAY_SITE_URL: "  " })).toBe("/sign/tok");
  });

  it("validates GATEWAY_SITE_URL as an http or https origin", () => {
    const base = {
      SUPABASE_URL: "http://127.0.0.1:55421",
      SUPABASE_ANON_KEY: "a".repeat(40),
      ATLAS_SITE_URL: "http://127.0.0.1:3000",
    };
    expect(parseEnv({ ...base, GATEWAY_SITE_URL: "http://127.0.0.1:3001" }).GATEWAY_SITE_URL).toBe(
      "http://127.0.0.1:3001",
    );
    expect(() => parseEnv({ ...base, GATEWAY_SITE_URL: "ftp://gateway" })).toThrow();
  });
});
