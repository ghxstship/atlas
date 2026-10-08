import { describe, expect, it } from "vitest";
import {
  compareSpecificity,
  fillRoute,
  matchRoute,
  parseRoute,
  routeParams,
  routeSyntaxProblems,
  routesOverlap,
} from "../src/index.ts";

const params = {
  org: { type: "slug" as const, reserved: ["legal"] },
  recordKey: { type: "record-key" as const },
  feedToken: { type: "token" as const },
  document: { type: "slug" as const },
};

describe("route patterns", () => {
  it("accepts lowercase hyphenated slugs and typed params", () => {
    expect(routeSyntaxProblems("/{org}/my-work")).toEqual([]);
    expect(routeSyntaxProblems("/ical/{feedToken}.ics")).toEqual([]);
    expect(routeSyntaxProblems("/")).toEqual([]);
  });

  it("refuses uppercase, underscores, missing slash and bad params", () => {
    expect(routeSyntaxProblems("home")).toHaveLength(1);
    expect(routeSyntaxProblems("/{org}/My_Work")).toHaveLength(1);
    expect(routeSyntaxProblems("/{Org}/home")).toHaveLength(1);
    expect(routeSyntaxProblems("/{org}//home")).toHaveLength(1);
  });

  it("parses segments and params", () => {
    expect(parseRoute("/")).toEqual([]);
    expect(parseRoute("/ical/{feedToken}.ics")).toEqual([
      { kind: "static", value: "ical" },
      { kind: "param", name: "feedToken", suffix: ".ics" },
    ]);
    expect(routeParams("/{org}/r/{recordKey}")).toEqual(["org", "recordKey"]);
  });

  it("matches concrete paths with typed params", () => {
    expect(matchRoute("/{org}/r/{recordKey}", "/acme/r/NWL-142?peek=NWL-1#x", params)).toEqual({
      org: "acme",
      recordKey: "NWL-142",
    });
    expect(matchRoute("/{org}/r/{recordKey}", "/acme/r/nwl-142", params)).toBeNull();
    expect(matchRoute("/{org}/r/{recordKey}", "/legal/r/NWL-1", params)).toBeNull();
    expect(matchRoute("/{org}/r/{recordKey}", "/acme/r", params)).toBeNull();
    expect(matchRoute("/{org}/home", "/acme/inbox", params)).toBeNull();
    expect(matchRoute("/ical/{feedToken}.ics", "/ical/abcdefghijklmnop1234.ics", params)).toEqual({
      feedToken: "abcdefghijklmnop1234",
    });
    expect(
      matchRoute("/ical/{feedToken}.ics", "/ical/abcdefghijklmnop1234.ical", params),
    ).toBeNull();
    expect(matchRoute("/{unknown}", "/x", params)).toBeNull();
    expect(matchRoute("/", "/", params)).toEqual({});
    expect(matchRoute("/", "", params)).toEqual({});
  });

  it("ranks static segments above params", () => {
    expect(compareSpecificity("/explore/saved", "/explore/{key}")).toBeLessThan(0);
    expect(compareSpecificity("/explore/{key}", "/explore/saved")).toBeGreaterThan(0);
    expect(compareSpecificity("/a/b", "/a/b")).toBe(0);
  });

  it("detects overlapping patterns", () => {
    expect(routesOverlap("/{org}/home", "/{org}/home", params)).toBe(true);
    expect(routesOverlap("/{org}/home", "/legal/{document}", params)).toBe(false);
    expect(routesOverlap("/{org}/home", "/acme/{document}", params)).toBe(true);
    expect(routesOverlap("/{org}/r/{recordKey}", "/{org}/r/new", params)).toBe(false);
    expect(routesOverlap("/ical/{feedToken}.ics", "/ical/today", params)).toBe(false);
    expect(routesOverlap("/a/{org}", "/a/{document}", params)).toBe(true);
    expect(routesOverlap("/a", "/a/b", params)).toBe(false);
  });

  it("fills patterns and refuses missing params", () => {
    expect(fillRoute("/{org}/r/{recordKey}", { org: "acme", recordKey: "NWL-1" })).toBe(
      "/acme/r/NWL-1",
    );
    expect(fillRoute("/ical/{feedToken}.ics", { feedToken: "t" })).toBe("/ical/t.ics");
    expect(() => fillRoute("/{org}/home", {})).toThrow(/missing route param "org"/);
  });
});
