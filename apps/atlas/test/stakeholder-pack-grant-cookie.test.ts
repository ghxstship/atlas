import { parsePackGrants } from "@xos/data/stakeholder-packs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: () => ({ ATLAS_SITE_URL: "https://atlas.example.com" }) }));

const { packGrantCookie, packGrantsFromHeader } = await import("@/lib/stakeholder-packs/public");

const grant = (digit: number) => `xpkg_${String(digit).repeat(64)}`;

describe("the pack grant cookie (B2, ADR 0141)", () => {
  it("is HttpOnly on /share/pack, and outlasts a grant that ends soon", () => {
    const cookie = packGrantCookie(null, grant(1), []);
    expect(cookie).toContain("Path=/share/pack");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    // 7 days whatever the new grant's own expiry: a pack ending tomorrow must not end the device's other packs' grants.
    expect(cookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
  });

  it("drops what the database says is dead and keeps another pack's live grant", () => {
    const swapped = grant(2);
    const other = grant(3);
    const cookie = packGrantCookie(`${swapped} ${other}`, grant(1), [swapped]);
    const value = packGrantsFromHeader(cookie.split(";")[0] ?? null);
    expect(parsePackGrants(value)).toEqual([grant(1), other]);
  });
});
