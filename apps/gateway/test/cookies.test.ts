import { describe, expect, it } from "vitest";
import { authCookieName, authCookieOptions } from "../lib/supabase/cookies";

describe("Gateway auth cookies (A22-014)", () => {
  it("are httpOnly, same-site and host-only with the __Host- prefix over https", () => {
    const options = authCookieOptions(true);
    expect(options).toMatchObject({
      name: "__Host-xos-auth",
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: true,
    });
    expect(options).not.toHaveProperty("domain");
  });

  it("drop the prefix only on local http, where browsers refuse prefixed cookies", () => {
    expect(authCookieName(false)).toBe("xos-auth");
    expect(authCookieOptions(false)).toMatchObject({ name: "xos-auth", secure: false });
  });
});
