import {
  FORM_FIELD_KINDS,
  fieldKey,
  formFieldProblems,
  type FormField,
  type FormFieldKind,
} from "@xos/data/workforce-forms";
import { surveyProblems, type SurveyQuestionInput } from "@xos/data/workforce-feed";

/**
 * Plain-text builders for the Atlas form and survey editors (A29). One line per field or question,
 * parts separated by a vertical bar, so a person types a whole form without a drag-and-drop canvas
 * and keyboard and screen reader users build it the same way. The parsers return every problem
 * found; the database checks again on save.
 *
 * Form field line:  Label | kind | required | choice A, choice B | if <key> = <value> | points A=2, B=0
 *   kind is one of text, long_text, number, yes_no, choice, multi_choice, date, photo
 * Survey question line:  Scale: prompt  |  Scale10: prompt  |  Choice: prompt | A | B  |  Text: prompt
 *   a trailing "(optional)" makes the question optional
 */

export interface ParsedFields {
  readonly fields: FormField[];
  readonly problems: string[];
}

function parseValue(raw: string): string | number | boolean {
  const v = raw.trim();
  if (v === "true" || v === "yes") return true;
  if (v === "false" || v === "no") return false;
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(v)) return Number(v);
  return v;
}

export function parseFieldList(source: string): ParsedFields {
  const fields: FormField[] = [];
  const problems: string[] = [];
  const lines = source
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  lines.forEach((line, i) => {
    const parts = line.split("|").map((p) => p.trim());
    const label = parts[0] ?? "";
    const kind = (parts[1] ?? "text").toLowerCase() as FormFieldKind;
    if (!(FORM_FIELD_KINDS as readonly string[]).includes(kind)) {
      problems.push(`kind:${i}`);
      return;
    }
    const field: {
      key: string;
      label: string;
      kind: FormFieldKind;
      required?: boolean;
      choices?: string[];
      points?: Record<string, number>;
      show_if?: { key: string; equals: string | number | boolean };
    } = {
      key: fieldKey(
        label,
        fields.map((f) => f.key),
      ),
      label,
      kind,
    };
    for (const part of parts.slice(2)) {
      const lower = part.toLowerCase();
      if (lower === "required") field.required = true;
      else if (lower.startsWith("if ")) {
        const match = /^if\s+([a-z][a-z0-9_]*)\s*=\s*(.+)$/i.exec(part);
        if (match)
          field.show_if = {
            key: (match[1] as string).toLowerCase(),
            equals: parseValue(match[2] as string),
          };
        else problems.push(`condition:${i}`);
      } else if (lower.startsWith("points ")) {
        const points: Record<string, number> = {};
        for (const pair of part.slice(7).split(",")) {
          const [answer, value] = pair.split("=").map((x) => x.trim());
          if (answer && value && /^-?[0-9]+(\.[0-9]+)?$/.test(value))
            points[answer] = Number(value);
          else problems.push(`points:${i}`);
        }
        field.points = points;
      } else if (part !== "") {
        field.choices = part
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c !== "");
      }
    }
    fields.push(field);
  });
  return { fields, problems: [...problems, ...formFieldProblems(fields)] };
}

/** The editable text of a field list, the inverse of parseFieldList. */
export function fieldListText(fields: readonly FormField[]): string {
  return fields
    .map((f) =>
      [
        f.label,
        f.kind,
        f.required ? "required" : null,
        f.choices && f.choices.length > 0 ? f.choices.join(", ") : null,
        f.show_if ? `if ${f.show_if.key} = ${String(f.show_if.equals)}` : null,
        f.points
          ? `points ${Object.entries(f.points)
              .map(([a, v]) => `${a}=${v}`)
              .join(", ")}`
          : null,
      ]
        .filter((p): p is string => p !== null)
        .join(" | "),
    )
    .join("\n");
}

export interface ParsedQuestions {
  readonly questions: SurveyQuestionInput[];
  readonly problems: string[];
}

export function parseSurveyQuestions(source: string): ParsedQuestions {
  const questions: SurveyQuestionInput[] = [];
  const problems: string[] = [];
  const lines = source
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  lines.forEach((line, i) => {
    const match = /^(scale10|scale|choice|text)\s*:\s*(.+)$/i.exec(line);
    if (!match) {
      problems.push(`line:${i}`);
      return;
    }
    const kindWord = (match[1] as string).toLowerCase();
    let rest = (match[2] as string).trim();
    const optional = /\(optional\)\s*$/i.test(rest);
    rest = rest.replace(/\(optional\)\s*$/i, "").trim();
    const parts = rest.split("|").map((p) => p.trim());
    const prompt = parts[0] ?? "";
    if (kindWord === "choice") {
      questions.push({
        prompt,
        kind: "Choice",
        choices: parts.slice(1).filter((c) => c !== ""),
        required: !optional,
      });
    } else if (kindWord === "text") {
      questions.push({ prompt, kind: "Text", required: !optional });
    } else {
      questions.push({
        prompt,
        kind: "Scale",
        scaleMax: kindWord === "scale10" ? 10 : 5,
        required: !optional,
      });
    }
  });
  return { questions, problems: [...problems, ...surveyProblems(questions)] };
}
