import { describe, expect, it } from "vitest";
import {
  playbookFieldMap,
  proposeTarget,
  sheetLayout,
  suggestWithSources,
} from "../src/import-parse.ts";
import {
  driveAccessToken,
  GoogleSheetError,
  MAX_SHEETS,
  readGoogleSheet,
  spreadsheetId,
  type SheetsFetch,
} from "../src/import-sheets.ts";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

describe("Google Sheets links", () => {
  it("reads the spreadsheet id of a docs.google.com link only", () => {
    expect(spreadsheetId(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)).toBe(ID);
    expect(spreadsheetId(`https://docs.google.com/spreadsheets/d/${ID}`)).toBe(ID);
    expect(spreadsheetId(`http://docs.google.com/spreadsheets/d/${ID}`)).toBeNull();
    expect(spreadsheetId(`https://docs.google.com.evil.test/spreadsheets/d/${ID}`)).toBeNull();
    expect(spreadsheetId("https://docs.google.com/document/d/abc")).toBeNull();
    expect(spreadsheetId("not a link")).toBeNull();
  });

  it("reads the access token of a stored Drive credential", () => {
    expect(driveAccessToken('{"access_token":"ya29-a"}')).toBe("ya29-a");
    expect(driveAccessToken('{"token":"ya29-b"}')).toBe("ya29-b");
    expect(driveAccessToken(" ya29-c ")).toBe("ya29-c");
    expect(() => driveAccessToken('{"refresh_token":"r"}')).toThrow(GoogleSheetError);
    expect(() => driveAccessToken("{broken")).toThrow("no access token");
  });

  it("refuses an invalid link, too many sheets or cells, and marks outages retryable", async () => {
    const respond =
      (
        meta: { status: number; body: unknown },
        values?: { status: number; body: unknown },
      ): SheetsFetch =>
      async (url) => {
        const route = url.includes("values:batchGet") ? (values ?? meta) : meta;
        return { status: route.status, json: async () => route.body };
      };
    await expect(
      readGoogleSheet(respond({ status: 200, body: {} }), "t", "https://x.test"),
    ).rejects.toMatchObject({
      code: "google_sheet_link_invalid",
    });
    const many = {
      sheets: Array.from({ length: MAX_SHEETS + 1 }, (_, i) => ({
        properties: { title: `S${i}`, index: i },
      })),
    };
    await expect(
      readGoogleSheet(
        respond({ status: 200, body: many }),
        "t",
        `https://docs.google.com/spreadsheets/d/${ID}`,
      ),
    ).rejects.toMatchObject({ code: "google_sheet_too_large" });
    const huge = {
      valueRanges: [
        { values: Array.from({ length: 1001 }, () => Array.from({ length: 500 }, () => "x")) },
      ],
    };
    await expect(
      readGoogleSheet(
        respond(
          { status: 200, body: { sheets: [{ properties: { title: "Big" } }] } },
          { status: 200, body: huge },
        ),
        "t",
        `https://docs.google.com/spreadsheets/d/${ID}`,
      ),
    ).rejects.toMatchObject({ code: "google_sheet_too_large" });
    await expect(
      readGoogleSheet(
        respond({ status: 429, body: {} }),
        "t",
        `https://docs.google.com/spreadsheets/d/${ID}`,
      ),
    ).rejects.toMatchObject({ code: "google_sheet_unavailable", retryable: true });
    await expect(
      readGoogleSheet(
        respond(
          { status: 200, body: { sheets: [{ properties: { title: "It's" } }] } },
          { status: 500, body: {} },
        ),
        "t",
        `https://docs.google.com/spreadsheets/d/${ID}`,
      ),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("keeps empty cells as empty text and quotes sheet names", async () => {
    const urls: string[] = [];
    const fetchImpl: SheetsFetch = async (url) => {
      urls.push(url);
      return url.includes("values:batchGet")
        ? { status: 200, json: async () => ({ valueRanges: [{ values: [["a", null, 3]] }, {}] }) }
        : {
            status: 200,
            json: async () => ({
              sheets: [
                { properties: { title: "It's", index: 1 } },
                { properties: { title: "First", index: 0 } },
              ],
            }),
          };
    };
    const book = await readGoogleSheet(
      fetchImpl,
      "t",
      `https://docs.google.com/spreadsheets/d/${ID}`,
    );
    expect(book).toEqual({
      title: "Google Sheet",
      sheets: [
        { name: "First", rows: [["a", "", "3"]] },
        { name: "It's", rows: [] },
      ],
    });
    expect(urls[1]).toContain("ranges=%27First%27&ranges=%27It%27%27s%27");
  });
});

describe("sheet detection and the Playbook map", () => {
  const playbook = [
    { sheet: "Projects", header: "VENUE", target: "app.venues.name" },
    { sheet: "Projects", header: "LOCATION", target: "app.venues.locality" },
    { sheet: "Budget Expenses", header: "LOCATION", target: "app.venues.name" },
    { sheet: "Vendor Directory", header: "COMPANY", target: "app.organizations.name" },
    { sheet: "Cover Page", header: "", target: "app.venues.name" },
  ];
  const targets = [
    {
      code: "venues",
      fields: ["name", "locality", "jurisdiction_id", "time_zone"],
      required: ["name", "jurisdiction_id", "time_zone"],
    },
    { code: "counterparties", fields: ["name", "counterparty_type"], required: ["name"] },
  ];

  it("maps Playbook headers to a target's fields and leaves out headers the map sends two ways", () => {
    const venues = playbookFieldMap(playbook, "venues", ["name", "locality"]);
    expect([...venues]).toEqual([["venue", "name"]]);
    expect([...playbookFieldMap(playbook, "counterparties", ["name"])]).toEqual([
      ["company", "name"],
    ]);
    expect([...playbookFieldMap(playbook, "nothing", ["name"])]).toEqual([]);
  });

  it("prefers a saved profile, then the Playbook map, then header similarity, each field once", () => {
    const suggestions = suggestWithSources(
      ["Company", "VENUE", "City", "Name"],
      ["name", "locality"],
      new Map([["company", "name"]]),
      new Map([["venue", "name"]]),
    );
    expect(suggestions).toEqual([
      { field: "name", source: "Profile" },
      { field: null, source: null },
      { field: "locality", source: "Header" },
      { field: null, source: null },
    ]);
  });

  it("proposes a target from the Playbook sheet name or the headers, or none", () => {
    const sheets = [{ sheet: "Vendor Directory", entity: "app.vendors" }];
    const sheet = (name: string, head: string[]) => ({ name, rows: [head, head.map(() => "x")] });
    expect(proposeTarget(sheet("vendor directory", ["X"]), targets, sheets, playbook)).toEqual({
      targetCode: "counterparties",
      fromPlaybook: true,
    });
    expect(
      proposeTarget(sheet("Rooms", ["Venue", "City", "Time Zone"]), targets, sheets, playbook),
    ).toEqual({
      targetCode: "venues",
      fromPlaybook: false,
    });
    expect(proposeTarget(sheet("Clients", ["Customer"]), targets, sheets, playbook)).toEqual({
      targetCode: "counterparties",
      fromPlaybook: false,
    });
    expect(proposeTarget(sheet("Notes", ["Thoughts"]), targets, sheets, playbook)).toEqual({
      targetCode: null,
      fromPlaybook: false,
    });
  });

  it("measures a sheet's header row and data range", () => {
    expect(
      sheetLayout({ name: "S", rows: [[], ["A", "B"], ["1", ""], [], ["2", "3"], [""]] }),
    ).toEqual({
      headerRow: 2,
      firstDataRow: 3,
      lastRow: 5,
      columnCount: 2,
      dataRowCount: 2,
    });
    expect(sheetLayout({ name: "E", rows: [] })).toEqual({
      headerRow: null,
      firstDataRow: null,
      lastRow: 0,
      columnCount: 0,
      dataRowCount: 0,
    });
  });
});
