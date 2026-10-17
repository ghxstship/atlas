/**
 * Forms that lose typed input after a refusal. React 19 resets an uncontrolled form once its
 * `<form action>` submission finishes, so a refused save would erase what the person typed. A form
 * keeps its input by submitting through `onSubmit={keepInputOnSubmit(formAction)}`, or by spreading
 * `{...keep}` from `useKeepInput` (Atlas
 * collection-kit/keep-input.ts, Gateway components/forms/keep-input.ts) and resetting itself only
 * after a save succeeds.
 *
 * The audit reads TSX source: every `<form>` that posts through `action=` without an `onSubmit`
 * handler and holds a field a person types into (or renders `children`, so a caller can add one) is
 * reported.
 */

export interface FormFinding {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

/** Elements a person types into or picks from; React resets their uncontrolled values. */
const FIELD =
  /<(?:Input|Textarea|TextField|Select|Combobox|MultiSelect|CurrencyInput|NumberInput|DatePicker|DateRangePicker|TimePicker|textarea|select)\b|<input\b(?![^>]*type=["'](?:hidden|submit|button)["'])|\{\s*children\s*\}|\bFields?\b[A-Z]?\w*\s*\/?>/;

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/** The opening tag starting at `start` (`<form ... >`), skipping `>` inside braces. */
function openingTag(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

export function findFormsThatLoseInput(file: string, source: string): FormFinding[] {
  const findings: FormFinding[] = [];
  for (const match of source.matchAll(/<form\b/g)) {
    const tag = openingTag(source, match.index);
    if (!/\baction=\{/.test(tag) || /\bonSubmit=\{|\{\.\.\.keep\w*\}/.test(tag)) continue;
    // A GET form navigates to a URL (search and filters); nothing is posted or reset.
    if (/\bmethod=["']get["']/i.test(tag)) continue;
    const close = source.indexOf("</form>", match.index);
    const body = source.slice(match.index + tag.length, close === -1 ? undefined : close);
    if (!FIELD.test(body)) continue;
    findings.push({
      file,
      line: lineOf(source, match.index),
      snippet: tag.replace(/\s+/g, " ").slice(0, 120),
    });
  }
  return findings;
}
