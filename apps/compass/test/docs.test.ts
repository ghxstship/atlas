import { describe, expect, it } from "vitest";
import { helpCenterUrl } from "../src/domain/docs";

/** The help center link in settings (RRR-119), from EXPO_PUBLIC_DOCS_URL. */
describe("help center link", () => {
  it("is hidden when the build has no docs site", () => {
    expect(helpCenterUrl(null, "en-US")).toBeNull();
    expect(helpCenterUrl("", "en-US")).toBeNull();
  });

  it("opens the docs help center in a locale the docs site serves", () => {
    expect(helpCenterUrl("https://docs.example.test/", "es-US")).toBe(
      "https://docs.example.test/es-US/help",
    );
    expect(helpCenterUrl("https://docs.example.test", "fr-CA")).toBe(
      "https://docs.example.test/en-US/help",
    );
  });
});
