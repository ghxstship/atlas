import { getMessages } from "@xos/i18n";
import { describe, expect, it } from "vitest";

/** B3 (ADR 0142): field history and exports name every new column, in both locales. */
const COLUMNS = [
  "caller_name",
  "token_hint",
  "expires_at",
  "failed_attempts",
  "open_count",
  "last_opened_at",
  "rotated_at",
  "show_channel",
  "script",
  "segment",
  "color_key",
  "position",
  "duration",
  "call_kind",
  "instruction",
  "library_version",
  "audience",
  "start_tbc",
  "standby_at",
];

function columnsOf(locale: "en-US" | "es-US"): Record<string, string> {
  const messages = getMessages(locale) as unknown as {
    views: { export: { columns: Record<string, string> } };
  };
  return messages.views.export.columns;
}

describe("B3's field-history labels", () => {
  it.each(["en-US", "es-US"] as const)("%s names every B3 column", (locale) => {
    const columns = columnsOf(locale);
    for (const column of COLUMNS) {
      expect(columns[column], column).toEqual(expect.stringMatching(/\S/));
    }
  });

  it("says who calls the show in es-US as show.json does", () => {
    expect(columnsOf("es-US")["caller_name"]).toBe("Quien llama el show");
  });
});
