import type { FieldValue, ObjectField } from "@xos/data/custom-objects";
import { z } from "zod";

/** The typed value a form field holds for a custom field, null for an empty field, or "invalid". */
export function parseValue(
  f: ObjectField,
  raw: string,
  currency: string,
): FieldValue | null | "invalid" {
  const v = raw.trim();
  if (v === "") return null;
  switch (f.dataType) {
    case "Text":
    case "Email":
    case "URL":
      return { kind: "text", value: v.slice(0, 10000) };
    case "Number":
      return Number.isFinite(Number(v)) ? { kind: "number", value: Number(v) } : "invalid";
    case "Money": {
      if (!/^\d+(\.\d{1,2})?$/.test(v)) return "invalid";
      const [whole, cents = ""] = v.split(".");
      return { kind: "money", minor: Number(whole) * 100 + Number(cents.padEnd(2, "0")), currency };
    }
    case "Date":
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? { kind: "date", value: v } : "invalid";
    case "Timestamp":
      return Number.isNaN(Date.parse(v))
        ? "invalid"
        : { kind: "timestamp", value: new Date(v).toISOString() };
    case "Boolean":
      return { kind: "boolean", value: v === "true" || v === "on" };
    case "Choice":
      return f.choices.some((c) => c.id === v) ? { kind: "choice", choiceId: v } : "invalid";
    case "Person":
      return z.uuid().safeParse(v).success ? { kind: "person", personId: v } : "invalid";
  }
}
