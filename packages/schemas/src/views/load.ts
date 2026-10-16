import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { SAVED_VIEW_TYPES, SHELLS, type ViewRegistry } from "./model.ts";

/** Path of packages/schemas/views.yaml. */
export const VIEWS_PATH = fileURLToPath(new URL("../../views.yaml", import.meta.url));

const CODE = /^[a-z][a-z0-9-]*$/;
const TRAIT = /^[a-z][a-z0-9_]*$/;
const ICON = /^[A-Z][A-Za-z0-9]*$/;

const fileSchema = z.strictObject({
  traits: z.array(
    z.strictObject({ code: z.string().regex(TRAIT), description: z.string().min(1).max(200) }),
  ),
  views: z.array(
    z.strictObject({
      code: z.string().regex(CODE),
      saved_as: z.enum(SAVED_VIEW_TYPES),
      icon: z.string().regex(ICON),
      requires: z.array(z.string().regex(TRAIT)),
      shells: z.array(z.enum(SHELLS)).min(1),
      alternative: z.boolean().optional(),
    }),
  ),
  defaults: z.array(z.object({ entity: z.string().regex(TRAIT) }).catchall(z.string().regex(CODE))),
});

/**
 * Parses and checks a view registry document: unique codes, known traits, and entity defaults that
 * name registered views. Throws with every problem listed.
 */
export function parseViewRegistry(text: string): ViewRegistry {
  const file = fileSchema.parse(parse(text));
  const problems: string[] = [];
  const traits = new Set(file.traits.map((t) => t.code));
  if (traits.size !== file.traits.length) problems.push("A trait is listed twice.");
  const codes = new Set(file.views.map((v) => v.code));
  if (codes.size !== file.views.length) problems.push("A view code is listed twice.");
  for (const view of file.views) {
    for (const t of view.requires) {
      if (!traits.has(t)) problems.push(`View ${view.code} requires unknown trait ${t}.`);
    }
  }
  const defaults = file.defaults.map((d) => {
    const { entity, ...views } = d;
    for (const [context, code] of Object.entries(views)) {
      if (!codes.has(code as string)) {
        problems.push(`Default ${entity}.${context} names unknown view ${String(code)}.`);
      }
    }
    return { entity, views: views as Record<string, string> };
  });
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return {
    traits: file.traits,
    views: file.views.map((v) => ({
      code: v.code,
      savedAs: v.saved_as,
      icon: v.icon,
      requires: v.requires,
      shells: v.shells,
      alternative: v.alternative ?? false,
    })),
    defaults,
  };
}

/** Reads packages/schemas/views.yaml. */
export function loadViewRegistry(path: string = VIEWS_PATH): ViewRegistry {
  return parseViewRegistry(readFileSync(path, "utf8"));
}
