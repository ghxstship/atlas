import { getMessages } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import {
  LARGE_TITLE_MAX_CHARACTERS,
  largeTitleFits,
  stackTitleOptions,
} from "../src/domain/titles";

describe("C-23: a page title is never cut short by the large-title header", () => {
  it("keeps short titles in the large title", () => {
    expect(largeTitleFits("Incidentes")).toBe(true);
    expect(stackTitleOptions("Incidents")).toEqual({
      title: "Incidents",
      headerTitle: "Incidents",
      headerLargeTitle: true,
    });
  });

  it("moves a title the one-line header would cut into the page", () => {
    const title = (
      getMessages("es-US") as unknown as { nav: { compass: { more: Record<string, string> } } }
    ).nav.compass.more["onboarding"];
    expect(title).toBe("Requisitos de incorporación");
    expect(largeTitleFits(String(title))).toBe(false);
    expect(stackTitleOptions(String(title))).toEqual({
      title,
      headerTitle: "",
      headerLargeTitle: false,
    });
  });

  it("counts characters, not UTF-16 units, at the limit", () => {
    expect(largeTitleFits("ñ".repeat(LARGE_TITLE_MAX_CHARACTERS))).toBe(true);
    expect(largeTitleFits("ñ".repeat(LARGE_TITLE_MAX_CHARACTERS + 1))).toBe(false);
  });

  it("leaves no empty large-title band for a page without a title", () => {
    expect(stackTitleOptions("")).toEqual({ title: "", headerTitle: "", headerLargeTitle: false });
  });
});
