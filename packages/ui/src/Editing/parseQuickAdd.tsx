import * as chrono from "chrono-node";
import { toIso } from "../lib/format.ts";
import { type QuickAddResult, type QuickAddToken } from "./Editing.types.ts";

const RULES: [RegExp, QuickAddToken["type"], string][] = [
  [/@([A-Za-z][\w.-]*)/g, "person", "User"],
  [/#([\w-]+)/g, "tag", "Hash"],
  [/\/([A-Za-z]+)/g, "kind", "Shapes"],
  [/~([\w-]+)/g, "scope", "MapPin"],
];

/**
 * Parses @person, #tag, /kind and ~scope tokens, then date phrases with chrono-node ("tomorrow",
 * "next Friday at 3pm"). What remains is the title.
 */
export function parseQuickAdd(text: string, referenceDate: Date = new Date()): QuickAddResult {
  const tokens: QuickAddToken[] = [];
  let title = text;
  for (const [pattern, type, icon] of RULES) {
    title = title.replace(pattern, (_match, value: string) => {
      tokens.push({ type, value, icon });
      return " ";
    });
  }
  const dates = chrono.parse(title, referenceDate, { forwardDate: true });
  for (const d of [...dates].reverse()) {
    const day = d.start.date();
    tokens.push({
      type: "date",
      value: d.text,
      icon: "Calendar",
      iso: toIso(day.getFullYear(), day.getMonth(), day.getDate()),
    });
    title = title.slice(0, d.index) + " " + title.slice(d.index + d.text.length);
  }
  return { title: title.replace(/\s+/g, " ").trim(), tokens };
}
