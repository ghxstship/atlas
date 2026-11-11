import { describe, expect, it } from "vitest";
import { hidesCookieBanner, isPublicLivePath } from "@/lib/shell/public-live-path";

/** B3 (ADR 0142): the portal sets only the grant cookie, so it loads no analytics and shows no banner. */
describe("public live paths", () => {
  const token = `xscl_${"a".repeat(64)}`;

  it("load no product analytics, the showcaller portal included", () => {
    expect(isPublicLivePath(`/share/view/xshv_${"a".repeat(64)}`)).toBe(true);
    expect(isPublicLivePath(`/share/screen/xscr_${"a".repeat(64)}`)).toBe(true);
    expect(isPublicLivePath(`/share/showcaller/${token}`)).toBe(true);
    expect(isPublicLivePath(`/share/showcaller/${token}/open`)).toBe(true);
    expect(isPublicLivePath(`/share/showcaller/${token}/clock`)).toBe(true);
  });

  it("leave analytics on elsewhere", () => {
    expect(isPublicLivePath("/northwind-live/show/run-of-show")).toBe(false);
    expect(isPublicLivePath("/share/other/x")).toBe(false);
    expect(isPublicLivePath("/share/showcaller")).toBe(false);
    expect(isPublicLivePath("")).toBe(false);
  });

  it("keep the cookie banner off a display screen and the portal, never a saved view", () => {
    expect(hidesCookieBanner(`/share/screen/xscr_${"a".repeat(64)}`)).toBe(true);
    expect(hidesCookieBanner(`/share/showcaller/${token}`)).toBe(true);
    expect(hidesCookieBanner(`/share/showcaller/${token}/clock`)).toBe(true);
    expect(hidesCookieBanner(`/share/view/xshv_${"a".repeat(64)}`)).toBe(false);
    expect(hidesCookieBanner("/northwind-live/inbox")).toBe(false);
  });

  it("are what the root layout asks", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const layout = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "app", "layout.tsx"),
      "utf8",
    );
    expect(layout).toContain("isPublicLivePath(path)");
    expect(layout).toContain("hidesCookieBanner(path)");
  });
});
