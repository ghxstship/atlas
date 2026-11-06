import { describe, expect, it } from "vitest";
import type { CustomFieldFormatContext } from "@/components/custom-fields/format";
import type { CustomField, CustomFieldValue } from "@/lib/custom-fields/types";
import { cueFieldChips } from "@/lib/show/cue-field-chips";

/** B3 (ADR 0142): a Crew field's chip reads as its value: a person by name, a choice with its color. */
const field = (over: Partial<CustomField>): CustomField =>
  ({
    id: "f1",
    targetTable: "app.cues",
    key: "camera",
    label: "Camera",
    dataType: "Text",
    required: false,
    filterable: false,
    sortOrder: 1,
    choices: [],
    ...over,
  }) as CustomField;

const context: CustomFieldFormatContext = {
  format: {
    dateTime: () => "",
    number: () => "",
  } as unknown as CustomFieldFormatContext["format"],
  yes: "Yes",
  no: "No",
  someone: "Someone",
  people: { "person-1": "Dana Reyes" },
  timeZone: "America/New_York",
};

const values = (byKey: Record<string, CustomFieldValue>) => new Map([["cue-1", byKey]]);

describe("cue field chips", () => {
  it("names the person of a Person field, not Someone", () => {
    const owner = field({ key: "owner", label: "Owner", dataType: "Person" });
    const chips = cueFieldChips(
      [owner],
      values({ owner: { type: "Person", personId: "person-1" } as CustomFieldValue }),
      context,
    );
    expect(chips["cue-1"]).toEqual([
      { key: "owner", label: "Owner", text: "Dana Reyes", colorKey: null },
    ]);
  });

  it("says Someone only for a person no longer among the members", () => {
    const owner = field({ key: "owner", label: "Owner", dataType: "Person" });
    const chips = cueFieldChips(
      [owner],
      values({ owner: { type: "Person", personId: "person-gone" } as CustomFieldValue }),
      context,
    );
    expect(chips["cue-1"]?.[0]?.text).toBe("Someone");
  });

  it("keeps a choice's color and skips a field with no value", () => {
    const look = field({
      key: "look",
      label: "Look",
      dataType: "Choice",
      choices: [
        { id: "c1", label: "Warm", colorKey: "cat-2" },
      ] as unknown as CustomField["choices"],
    });
    const chips = cueFieldChips(
      [look, field({})],
      values({ look: { type: "Choice", choiceId: "c1" } as CustomFieldValue }),
      context,
    );
    expect(chips["cue-1"]).toEqual([
      { key: "look", label: "Look", text: "Warm", colorKey: "cat-2" },
    ]);
  });
});
