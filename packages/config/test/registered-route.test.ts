import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import {
  compileRoute,
  pathMatches,
  pathSegments,
  registeredRoute,
} from "../eslint/registered-route.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const options = [
  {
    routes: [
      "/",
      "/auth/sign-in",
      "/legal/{document}",
      "/{org}/home",
      "/{org}/p/{projectKey}/overview",
      "/{org}/p/{projectKey}/gates",
      "/ical/{feedToken}.ics",
      "/api/v1/{...path}",
      "/inspections/{templateId}",
    ],
    ignore: ["^/icons/"],
  },
];
const unknown = (path: string) => ({ messageId: "unknown", data: { path } });

// S3.15-10: every in-app path the code links or navigates to is a sitemap or shell route.
tester.run("xos/registered-route", registeredRoute, {
  valid: [
    { code: `const a = <Link href="/auth/sign-in" />;`, options },
    { code: "const a = <Link href={`/${org}/home`} />;", options },
    { code: "const a = <Link href={`/${org}/home?peek=${key}#top`} />;", options },
    { code: `const a = <a href="/" />;`, options },
    { code: "const a = <Link href={`/${org}/p/${key}/${tab}`} />;", options },
    { code: "const a = <Link href={`/legal/${doc}`} />;", options },
    { code: "const a = <Link href={`/ical/${token}.ics`} />;", options },
    { code: `fetchLike({ href: "/api/v1/projects/abc" });`, options },
    { code: `redirect("/auth/sign-in?next=%2Fhome");`, options },
    { code: "router.push(`/${org}/home/`);", options },
    {
      code: `router.push({ pathname: "/inspections/[templateId]", params: { templateId } });`,
      options,
    },
    { code: "NextResponse.redirect(new URL(`/${org}/home`, request.url));", options },
    { code: `const a = <Link href={done ? "/auth/sign-in" : "/"} />;`, options },
    // Not in-app absolute paths.
    { code: `const a = <a href="https://example.com/x" />;`, options },
    { code: `const a = <a href="mailto:ops@example.com" />;`, options },
    { code: "const a = <a href={`?peek=${key}`} />;", options },
    { code: "const a = <a href={`${base}/nowhere`} />;", options },
    { code: `const a = <a href="//cdn.example.com/x.js" />;`, options },
    { code: `const a = <img href="/icons/logo.svg" />;`, options },
    // Not a navigation call or href.
    { code: `fetch("/nowhere");`, options },
    { code: `list.push("/nowhere");`, options },
    { code: `const a = { route: "/nowhere" };`, options },
  ],
  invalid: [
    {
      code: `const a = <Link href="/auth/sign-on" />;`,
      options,
      errors: [unknown("/auth/sign-on")],
    },
    { code: "const a = <Link href={`/${org}/hom`} />;", options, errors: [unknown("/${…}/hom")] },
    // A substitution standing for a whole segment is a value, not a fixed segment, unless last.
    {
      code: "const a = <Link href={`/${org}/${doc}/x`} />;",
      options,
      errors: [unknown("/${…}/${…}/x")],
    },
    {
      code: "const a = <Link href={`/${org}/p/${key}/gate`} />;",
      options,
      errors: [unknown("/${…}/p/${…}/gate")],
    },
    {
      code: "const a = <Link href={`/ical/${token}.ical`} />;",
      options,
      errors: [unknown("/ical/${…}.ical")],
    },
    { code: `redirect("/auth/signin?next=x");`, options, errors: [unknown("/auth/signin?next=x")] },
    { code: `permanentRedirect("/home");`, options, errors: [unknown("/home")] },
    { code: "router.replace(`/${org}/projects`);", options, errors: [unknown("/${…}/projects")] },
    { code: `appRouter.prefetch("/x");`, options, errors: [unknown("/x")] },
    { code: `router.navigate("/today");`, options, errors: [unknown("/today")] },
    {
      code: `router.push({ pathname: "/inspections/[templateId]/edit", params: { templateId } });`,
      options,
      errors: [unknown("/inspections/[templateId]/edit")],
    },
    { code: `const item = { href: "/settings" };`, options, errors: [unknown("/settings")] },
    {
      code: `const a = <Link href={done ? "/auth/sign-in" : "/auth/out"} />;`,
      options,
      errors: [unknown("/auth/out")],
    },
    { code: `const a = <Link href={target ?? "/nope"} />;`, options, errors: [unknown("/nope")] },
    { code: `const a = <Link href={"/nope" as const} />;`, options, errors: [unknown("/nope")] },
    {
      code: `NextResponse.redirect(new URL("/auth/sign-out", request.url));`,
      options,
      errors: [unknown("/auth/sign-out")],
    },
    { code: `const a = <a href="/api/v1" />;`, options, errors: [unknown("/api/v1")] },
  ],
});

describe("route matching", () => {
  it("compiles static, parameter, suffixed and rest segments", () => {
    expect(compileRoute("/")).toEqual([]);
    expect(compileRoute("/ical/{feedToken}.ics")).toEqual([
      { kind: "static", value: "ical" },
      { kind: "param", suffix: ".ics" },
    ]);
    expect(compileRoute("/api/{...path}")).toEqual([
      { kind: "static", value: "api" },
      { kind: "rest" },
    ]);
  });

  it("splits only absolute in-app paths and drops the query, fragment and trailing slash", () => {
    expect(pathSegments("/a/b/?x=1#y")).toEqual(["a", "b"]);
    expect(pathSegments("/")).toEqual([]);
    expect(pathSegments("a/b")).toBeNull();
    expect(pathSegments("//host/a")).toBeNull();
  });

  it("needs a rest segment to have at least one segment to take", () => {
    const route = compileRoute("/api/v1/{...path}");
    expect(pathMatches(route, ["api", "v1", "a", "b"])).toBe(true);
    expect(pathMatches(route, ["api", "v1"])).toBe(false);
  });
});
