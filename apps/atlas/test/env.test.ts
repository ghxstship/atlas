import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "../lib/env";
import { authCookieOptions } from "../lib/supabase/cookies";

const valid = {
  SUPABASE_URL: "http://127.0.0.1:55421",
  SUPABASE_ANON_KEY: "a".repeat(40),
  ATLAS_SITE_URL: "http://127.0.0.1:3000",
};

describe("environment", () => {
  it("accepts the local stack values and defaults NODE_ENV", () => {
    expect(parseEnv(valid)).toEqual({ ...valid, NODE_ENV: "development" });
  });

  it("names every invalid variable in one error", () => {
    let thrown: unknown;
    try {
      parseEnv({ SUPABASE_URL: "not a url" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvError);
    const message = (thrown as Error).message;
    expect(message).toContain("SUPABASE_URL");
    expect(message).toContain("SUPABASE_ANON_KEY");
    expect(message).toContain("ATLAS_SITE_URL");
    expect(message).toContain(".env.example");
  });
});

describe("auth cookies", () => {
  it("are httpOnly and same-site, and secure in production", () => {
    expect(authCookieOptions(true)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    });
    expect(authCookieOptions(false).secure).toBe(false);
  });

  it("carry the __Host- prefix over https and keep local http working (A22-014)", () => {
    expect(authCookieOptions(true)).toMatchObject({ name: "__Host-xos-auth", path: "/" });
    expect(authCookieOptions(true)).not.toHaveProperty("domain");
    expect(authCookieOptions(false).name).toBe("xos-auth");
  });
});
