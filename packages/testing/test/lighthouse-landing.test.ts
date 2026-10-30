import { describe, expect, it } from "vitest";
import {
  PAGES_PER_SESSION,
  batches,
  cookieHeader,
  landingPath,
  landingPaths,
} from "../src/lighthouse-landing.ts";

/** A fake server: each path answers with its redirect target, or 200 when it has none. */
function server(
  redirects: Record<string, string>,
  seen: { url: string; init: RequestInit }[] = [],
) {
  return async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const location = redirects[new URL(url).pathname];
    return location === undefined
      ? { status: 200, headers: new Headers() }
      : { status: 307, headers: new Headers({ location }) };
  };
}

describe("landingPath", () => {
  it("follows the app's redirects with the session's cookies, without following them itself", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = server(
      { "/money": "/money/overview", "/work": "http://x/work/upcoming" },
      calls,
    );
    expect(await landingPath("http://x", "/money", "a=1", fetchImpl)).toBe("/money/overview");
    expect(await landingPath("http://x", "/work", "a=1", fetchImpl)).toBe("/work/upcoming");
    expect(await landingPath("http://x", "/home", "a=1", fetchImpl)).toBe("/home");
    expect(calls[0]?.init).toEqual({ redirect: "manual", headers: { cookie: "a=1" } });
  });

  it("keeps the query a saved view lands on", async () => {
    const fetchImpl = server({ "/o/views/v1": "/o/projects?view=table&sort=name" });
    expect(await landingPath("http://x", "/o/views/v1", null, fetchImpl)).toBe(
      "/o/projects?view=table&sort=name",
    );
  });

  it("stops a signed-in run that is sent to sign in, or off the app", async () => {
    const fetchImpl = server({
      "/home": "/auth/sign-in?next=%2Fhome",
      "/out": "https://elsewhere/",
    });
    await expect(landingPath("http://x", "/home", "a=1", fetchImpl)).rejects.toThrow(
      /session ended/,
    );
    await expect(landingPath("http://x", "/out", null, fetchImpl)).rejects.toThrow(/off the app/);
  });

  it("gives up after five hops rather than loop", async () => {
    const fetchImpl = server({ "/a": "/b", "/b": "/a" });
    expect(await landingPath("http://x", "/a", null, fetchImpl)).toMatch(/^\/[ab]$/);
  });
});

describe("landingPaths", () => {
  it("visits each landing path once, across the batches that share `seen`", async () => {
    const fetchImpl = server({ "/o/p/NWS": "/o/p/NWS/overview" });
    const seen = new Set<string>();
    expect(await landingPaths("http://x", ["/o/p/NWS", "/o/inbox"], null, seen, fetchImpl)).toEqual(
      ["/o/p/NWS/overview", "/o/inbox"],
    );
    expect(await landingPaths("http://x", ["/o/p/NWS/overview"], null, seen, fetchImpl)).toEqual(
      [],
    );
  });
});

describe("batches and cookieHeader", () => {
  it("splits a person's pages into sessions of at most 40", () => {
    const paths = Array.from({ length: 95 }, (_, i) => `/p${i}`);
    expect(batches(paths).map((b) => b.length)).toEqual([40, 40, 15]);
    expect(PAGES_PER_SESSION).toBe(40);
    expect(batches([])).toEqual([]);
  });

  it("joins the session cookies as a browser sends them", () => {
    expect(
      cookieHeader([
        { name: "xos-auth.0", value: "base64-a" },
        { name: "xos-auth.1", value: "b" },
      ]),
    ).toBe("xos-auth.0=base64-a; xos-auth.1=b");
    expect(cookieHeader(null)).toBeNull();
  });
});
