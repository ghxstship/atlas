import { describe, expect, it } from "vitest";
import { fieldListText, parseFieldList, parseSurveyQuestions } from "../lib/workforce/parse";
import { formMediaPath } from "../lib/workforce/media";

describe("form field lists", () => {
  it("parses labels, kinds, required, choices, conditions and points", () => {
    const parsed = parseFieldList(
      [
        "Hoist inspected | yes_no | required | points true=2",
        "Defect found | long_text | required | if hoist_inspected = false",
        "Load class | choice | Light, Medium, Heavy | points Light=1, Heavy=0",
        "Photos | photo | required",
      ].join("\n"),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.fields.map((f) => f.key)).toEqual([
      "hoist_inspected",
      "defect_found",
      "load_class",
      "photos",
    ]);
    expect(parsed.fields[1]?.show_if).toEqual({ key: "hoist_inspected", equals: false });
    expect(parsed.fields[2]?.choices).toEqual(["Light", "Medium", "Heavy"]);
    expect(parsed.fields[2]?.points).toEqual({ Light: 1, Heavy: 0 });
    expect(parseFieldList(fieldListText(parsed.fields)).fields).toEqual(parsed.fields);
  });

  it("reports bad kinds, conditions, points and choice counts", () => {
    expect(parseFieldList("A | slider").problems).toEqual(["kind:0", "fieldCount"]);
    expect(parseFieldList("A | text | if = x").problems).toEqual(["condition:0"]);
    expect(parseFieldList("A | yes_no | points yes=lots").problems).toEqual(["points:0"]);
    expect(parseFieldList("A | choice | Only").problems).toEqual(["choices:0"]);
    expect(parseFieldList("").problems).toEqual(["fieldCount"]);
    expect(parseFieldList("Count | number | if missing = 3").problems).toEqual(["condition:0"]);
  });
});

describe("survey question lists", () => {
  it("parses scale, choice and text questions with optional ones", () => {
    const parsed = parseSurveyQuestions(
      [
        "Scale: How safe did it feel?",
        "Scale10: Rate the catering",
        "Choice: Best shift? | Morning | Night",
        "Text: Anything else? (optional)",
      ].join("\n"),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.questions).toEqual([
      { prompt: "How safe did it feel?", kind: "Scale", scaleMax: 5, required: true },
      { prompt: "Rate the catering", kind: "Scale", scaleMax: 10, required: true },
      { prompt: "Best shift?", kind: "Choice", choices: ["Morning", "Night"], required: true },
      { prompt: "Anything else?", kind: "Text", required: false },
    ]);
  });

  it("refuses lines it cannot read", () => {
    expect(parseSurveyQuestions("How was it?").problems).toContain("line:0");
    expect(parseSurveyQuestions("Choice: One? | A").problems).toContain("choices:0");
  });
});

describe("form media paths", () => {
  it("names objects in the submitter's own forms folder, images only", () => {
    expect(formMediaPath("o", "p", "image/png", "x")).toBe("o/forms/p/x.png");
    expect(formMediaPath("o", "p", "image/jpeg", "x")).toBe("o/forms/p/x.jpg");
    expect(formMediaPath("o", "p", "application/pdf")).toBeNull();
  });
});
