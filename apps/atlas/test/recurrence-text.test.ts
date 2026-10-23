import { getMessages } from "@xos/i18n";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { describeRrule } from "../lib/work/recurrence-text";

/** A59-017: a recurrence reads "Weekly on Mon", never FREQ=WEEKLY;BYDAY=MO. */

type Tree = { readonly [key: string]: string | Tree };

function translator(locale: "en-US" | "es-US") {
  const work = (getMessages(locale) as unknown as Record<string, Tree>)["work"] as Tree;
  const recurrence = work["recurrence"] as Tree;
  return (key: string, values?: Record<string, string | number>) => {
    let node: string | Tree | undefined = recurrence;
    for (const part of key.split(".")) node = typeof node === "object" ? node[part] : undefined;
    if (typeof node !== "string") throw new Error(`missing work.recurrence.${key}`);
    return String(new IntlMessageFormat(node, locale).format(values));
  };
}

describe("recurrence rules in words", () => {
  const t = translator("en-US");

  it("reads the rules the editor writes", () => {
    expect(describeRrule("FREQ=WEEKLY;BYDAY=MO", t)).toBe("Weekly on Mon");
    expect(describeRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", t)).toBe(
      "Every 2 weeks on Mon, Wed",
    );
    expect(describeRrule("FREQ=DAILY", t)).toBe("Daily");
    expect(describeRrule("FREQ=DAILY;INTERVAL=3", t)).toBe("Every 3 days");
    expect(describeRrule("FREQ=MONTHLY", t)).toBe("Monthly");
  });

  it("calls anything else a custom rule, never the raw text", () => {
    expect(describeRrule("FREQ=YEARLY;BYMONTH=3", t)).toBe("Custom rule");
    expect(describeRrule("", t)).toBe("Custom rule");
  });

  it("reads in Spanish", () => {
    expect(describeRrule("FREQ=WEEKLY;BYDAY=MO", translator("es-US"))).not.toContain("FREQ");
  });
});
