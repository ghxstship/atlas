import { describe as suite, expect, it } from "vitest";
import {
  contentText,
  describe,
  hardCoded,
  isData,
  jsonStrings,
  withText,
  type Found,
} from "../src/pseudo-text.ts";

const data = new Set(["Northwind Summer Series", "Jordan Lee", "NWS"]);

suite("pseudo-locale text", () => {
  it("counts database values, codes and Intl shapes as data", () => {
    expect(isData("Northwind Summer Series", data)).toBe(true);
    expect(isData("· NWS", data)).toBe(true);
    expect(isData("NWS-12", data)).toBe(true);
    expect(isData("US-FL-MIAMI-DADE", data)).toBe(true);
    expect(isData("Mar 4, 2027", data)).toBe(true);
    expect(isData("3 days ago", data)).toBe(true);
    expect(isData("$1,250.00", data)).toBe(true);
    expect(isData("10:30 AM", data)).toBe(true);
    expect(isData("owner@example.com", data)).toBe(true);
    expect(isData("https://docs.example.com/guides", data)).toBe(true);
    expect(isData("JL", data)).toBe(true);
    expect(isData("NWS · Northwind Summer Series", data)).toBe(true);
    expect(isData("Jordan Lee, Mar 4", data)).toBe(true);
    expect(isData("42", data)).toBe(true);
  });

  it("finds copy that missed a catalog, and raw keys even when the data holds them", () => {
    expect(isData("Save changes", data)).toBe(false);
    expect(isData("Jordan Lee, Save changes", data)).toBe(false);
    expect(isData("project.created", new Set(["project.created"]))).toBe(false);
  });

  it("reports each hard-coded text and place once", () => {
    const found: Found[] = [
      { text: "Save changes", where: "main > button" },
      { text: "Save changes", where: "main > button" },
      { text: "Save changes", where: "dialog > button" },
      { text: "Jordan Lee", where: "main > td" },
    ];
    const left = hardCoded(found, data);
    expect(left).toEqual([found[0], found[2]]);
    expect(describe(left)).toEqual([
      '"Save changes" at main > button',
      '"Save changes" at dialog > button',
    ]);
  });

  it("knows any run of long-form content, split wherever inline markup falls", () => {
    const content = contentText(["Use the **xos** CLI\n  to create a project.", "Webhooks"]);
    expect(content.has("Use the")).toBe(true);
    expect(content.has("CLI to create a project.")).toBe(true);
    expect(content.has("Webhooks")).toBe(true);
    expect(content.has("Delete everything")).toBe(false);
    expect(content.has("  ")).toBe(false);
    expect(isData("CLI to create a project.", content)).toBe(true);
  });

  it("adds the values a test wrote after the data was loaded", () => {
    const more = withText(data, [" Rigging Advance K2QX "]);
    expect(more.has("Rigging Advance K2QX")).toBe(true);
    expect(more.has("Jordan Lee")).toBe(true);
    expect(more.has("Rigging Advance")).toBe(false);
  });

  it("collects every string and key of a JSON document", () => {
    expect(jsonStrings({ summary: "List project rows", tags: ["Projects", 3, null] })).toEqual([
      "summary",
      "List project rows",
      "tags",
      "Projects",
    ]);
  });
});
