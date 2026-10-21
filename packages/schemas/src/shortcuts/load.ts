import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import {
  RESERVED_REASONS,
  registryProblems,
  SHORTCUT_SHELLS,
  type ShellShortcuts,
  type ShortcutRegistry,
} from "./model.ts";

/** Path of packages/schemas/shortcuts.yaml. */
export const SHORTCUTS_PATH = fileURLToPath(new URL("../../shortcuts.yaml", import.meta.url));

const ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const LABEL = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const NODE = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;

const shellSchema = z.strictObject({
  scopes: z.array(z.string().regex(ID)).min(1),
  groups: z.array(z.strictObject({ id: z.string().regex(ID), label: z.string().regex(LABEL) })),
  shortcuts: z.array(
    z.strictObject({
      id: z.string().regex(ID).max(60),
      scope: z.string().regex(ID),
      group: z.string().regex(ID),
      keys: z.string().optional(),
      mac: z.string().optional(),
      label: z.string().regex(LABEL),
      fields: z.boolean().optional(),
      fixed: z.boolean().optional(),
      go: z.string().regex(NODE).optional(),
    }),
  ),
});

const fileSchema = z.strictObject({
  version: z.literal(1),
  reserved: z.array(
    z.strictObject({
      keys: z.string(),
      reason: z.enum(RESERVED_REASONS),
      platform: z.enum(["mac", "other"]).optional(),
    }),
  ),
  shells: z.strictObject(
    Object.fromEntries(SHORTCUT_SHELLS.map((s) => [s, shellSchema])) as Record<
      (typeof SHORTCUT_SHELLS)[number],
      typeof shellSchema
    >,
  ),
});

function toShell(raw: z.infer<typeof shellSchema>): ShellShortcuts {
  return {
    scopes: raw.scopes,
    groups: raw.groups,
    shortcuts: raw.shortcuts.map((s) => ({
      id: s.id,
      scope: s.scope,
      group: s.group,
      keys: s.keys ?? null,
      mac: s.mac ?? null,
      label: s.label,
      fields: s.fields ?? false,
      fixed: s.fixed ?? false,
      go: s.go ?? null,
    })),
  };
}

/**
 * Parses and checks a shortcut registry document. Throws with every problem listed: unknown fields,
 * keys outside the grammar, reserved defaults and defaults that conflict where their scopes meet.
 */
export function parseShortcutRegistry(text: string): ShortcutRegistry {
  const file = fileSchema.parse(parse(text));
  const registry: ShortcutRegistry = {
    reserved: file.reserved.map((r) => ({
      keys: r.keys,
      reason: r.reason,
      platform: r.platform ?? null,
    })),
    shells: {
      atlas: toShell(file.shells.atlas),
      gateway: toShell(file.shells.gateway),
    },
  };
  const problems = registryProblems(registry);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return registry;
}

/** Reads packages/schemas/shortcuts.yaml. */
export function loadShortcutRegistry(path: string = SHORTCUTS_PATH): ShortcutRegistry {
  return parseShortcutRegistry(readFileSync(path, "utf8"));
}
