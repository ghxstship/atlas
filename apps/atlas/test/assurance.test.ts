import { describe, expect, it } from "vitest";
import {
  MFA_PATH,
  opensWithoutSecondFactor,
  orgAuthRedirect,
  parseLastSeen,
  recordsLastSeen,
  relyingPartyFrom,
  secondFactorRedirect,
} from "../lib/auth/assurance";

describe("where a session that owes something goes (A77)", () => {
  it("lets sign-in, sign-out, the auth returns and legal pages open without the second factor", () => {
    for (const path of [
      MFA_PATH,
      "/auth/sign-in",
      "/auth/sign-out",
      "/auth/callback",
      "/legal/terms",
    ]) {
      expect(opensWithoutSecondFactor(path)).toBe(true);
    }
    for (const path of ["/", "/acme/home", "/auth/organization", "/auth/network-restricted"]) {
      expect(opensWithoutSecondFactor(path)).toBe(false);
    }
  });

  it("returns to the page after the second factor, never to another site", () => {
    expect(secondFactorRedirect("/acme/home", "?view=list")).toBe(
      "/auth/mfa?next=%2Facme%2Fhome%3Fview%3Dlist",
    );
    expect(secondFactorRedirect("/acme/home", "", "acme")).toBe(
      "/auth/mfa?next=%2Facme%2Fhome&org=acme",
    );
    expect(secondFactorRedirect("//evil.example", "")).toBe("/auth/mfa?next=%2F");
  });

  it("sends an org's decision to verify or to sign in again", () => {
    expect(orgAuthRedirect("ok", "acme", "/acme/home", "")).toBeNull();
    expect(orgAuthRedirect("mfa", "acme", "/acme/home", "")).toBe(
      "/auth/mfa?next=%2Facme%2Fhome&org=acme",
    );
    expect(orgAuthRedirect("session-expired", "acme", "/acme/home", "")).toBe(
      "/auth/session-ended?org=acme&reason=lifetime&next=%2Facme%2Fhome",
    );
    expect(orgAuthRedirect("idle", "acme", "/acme/home", "")).toBe(
      "/auth/session-ended?org=acme&reason=idle&next=%2Facme%2Fhome",
    );
  });

  it("reads the last-seen cookie and ignores anything else", () => {
    expect(parseLastSeen("1792503122000")).toBe(1792503122000);
    expect(parseLastSeen(undefined)).toBeNull();
    expect(parseLastSeen("soon")).toBeNull();
  });

  it("records the last-seen time at most once a minute, so actions do not refresh the page each time", () => {
    const at = 1792503122000;
    expect(recordsLastSeen(null, at)).toBe(true);
    expect(recordsLastSeen(at, at + 59_999)).toBe(false);
    expect(recordsLastSeen(at, at + 60_000)).toBe(true);
    // A clock that went back records again rather than keeping a future time.
    expect(recordsLastSeen(at, at - 1)).toBe(true);
  });

  it("takes the relying party from configuration, or none when it is incomplete", () => {
    expect(
      relyingPartyFrom({
        WEBAUTHN_RP_ID: "ghxstship.tech",
        WEBAUTHN_RP_ORIGINS: "https://atlas.ghxstship.tech, https://gateway.ghxstship.tech",
      }),
    ).toEqual({
      id: "ghxstship.tech",
      origins: ["https://atlas.ghxstship.tech", "https://gateway.ghxstship.tech"],
    });
    expect(relyingPartyFrom({ WEBAUTHN_RP_ID: "localhost" })).toBeNull();
    expect(relyingPartyFrom({ WEBAUTHN_RP_ORIGINS: "http://localhost:3000" })).toBeNull();
    expect(
      relyingPartyFrom({ WEBAUTHN_RP_ID: "localhost", WEBAUTHN_RP_ORIGINS: "not a url" }),
    ).toBeNull();
  });
});
