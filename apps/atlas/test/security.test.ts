import { describe, expect, it } from "vitest";
import {
  buildCsp,
  createNonce,
  isCrossSiteMutation,
  securityHeaders,
} from "../lib/security/headers";

describe("content security policy", () => {
  const production = buildCsp({
    nonce: "abc123",
    development: false,
    supabaseOrigin: "https://db.example.test",
    secureSite: true,
  });

  it("runs only nonce-bearing scripts, frames nothing and allows no plugins", () => {
    expect(production).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(production).not.toContain("unsafe-eval");
    expect(production).toContain("style-src 'self' 'nonce-abc123'");
    expect(production).toContain("object-src 'none'");
    expect(production).toContain("frame-ancestors 'none'");
    expect(production).toContain(
      "form-action 'self' https://db.example.test https://accounts.google.com;",
    );
    expect(production).toContain("upgrade-insecure-requests");
  });

  it("connects only to itself and the Supabase Realtime socket", () => {
    expect(production).toContain("connect-src 'self' wss://db.example.test;");
  });

  it("adds only what the dev server needs in development", () => {
    const dev = buildCsp({
      nonce: "n",
      development: true,
      supabaseOrigin: "http://127.0.0.1:55421",
      secureSite: false,
    });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("connect-src 'self' ws: wss:");
    expect(dev).not.toContain("upgrade-insecure-requests");
  });

  it("issues a fresh 128-bit nonce each time", () => {
    const a = createNonce();
    expect(atob(a)).toHaveLength(16);
    expect(createNonce()).not.toBe(a);
  });
});

describe("security headers", () => {
  it("sends HSTS with preload on https", () => {
    expect(securityHeaders(true)["Strict-Transport-Security"]).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
    expect(securityHeaders(false)["Strict-Transport-Security"]).toBeUndefined();
    expect(securityHeaders(true)["X-Frame-Options"]).toBe("DENY");
    expect(securityHeaders(true)["X-Content-Type-Options"]).toBe("nosniff");
  });
});

describe("CSRF origin check", () => {
  const site = "https://atlas.example.test";
  const check = (method: string, origin: string | null, host = "atlas.example.test") =>
    isCrossSiteMutation({ method, origin, host, siteOrigin: site });

  it("lets safe methods through", () => {
    expect(check("GET", null)).toBe(false);
    expect(check("HEAD", "https://evil.example")).toBe(false);
  });

  it("accepts same-site posts and refuses cross-site or origin-less ones", () => {
    expect(check("POST", "https://atlas.example.test")).toBe(false);
    expect(check("POST", "http://127.0.0.1:3006", "127.0.0.1:3006")).toBe(false);
    expect(check("POST", "https://evil.example")).toBe(true);
    expect(check("POST", null)).toBe(true);
    expect(check("POST", "not a url")).toBe(true);
    expect(check("DELETE", "https://evil.example", "atlas.example.test")).toBe(true);
  });
});
