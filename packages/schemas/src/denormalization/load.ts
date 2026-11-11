import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import {
  ARRAY_KINDS,
  JSON_EXCEPTIONS,
  registerProblems,
  RESTATED_KINDS,
  STORED_KINDS,
  TABLE_KINDS,
  type DenormalizationRegister,
} from "./model.ts";

/** Path of docs/adr/denormalization-register.yaml. */
export const REGISTER_PATH = fileURLToPath(
  new URL("../../../../docs/adr/denormalization-register.yaml", import.meta.url),
);

const text = z.string().trim().min(1);

function reviewed<K extends readonly [string, ...string[]]>(kinds: K) {
  return {
    kind: z.enum(kinds),
    note: text,
    finding: z.string().optional(),
  };
}

const fileSchema = z.strictObject({
  version: z.literal(1),
  derived: z.array(
    z.strictObject({
      objects: z.array(z.string()).min(1),
      source: text,
      refresh: text,
      reason: text,
      adr: z.string().regex(/^\d{4}$/),
    }),
  ),
  own_names: z.array(z.strictObject({ name: z.string(), note: text })),
  json: z.array(z.strictObject({ column: z.string(), ...reviewed(JSON_EXCEPTIONS) })),
  arrays: z.array(z.strictObject({ column: z.string(), ...reviewed(ARRAY_KINDS) })),
  restated: z.array(
    z.strictObject({ column: z.string(), parent: z.string(), ...reviewed(RESTATED_KINDS) }),
  ),
  stored: z.array(z.strictObject({ column: z.string(), ...reviewed(STORED_KINDS) })),
  tenant_exceptions: z.array(
    z.strictObject({ table: z.string(), kind: z.enum(TABLE_KINDS), note: text }),
  ),
});

const withFinding = <T extends { finding?: string | undefined }>(e: T) => ({
  ...e,
  finding: e.finding ?? null,
});

/**
 * Parses and checks a register document. Throws with every problem listed: unknown fields, unknown kinds, names
 * outside the linted schemas, duplicates, unsorted lists and `registered` entries no derived entry names.
 */
export function parseDenormalizationRegister(source: string): DenormalizationRegister {
  const file = fileSchema.parse(parse(source));
  const register: DenormalizationRegister = {
    derived: file.derived,
    ownNames: file.own_names,
    json: file.json.map(withFinding),
    arrays: file.arrays.map(withFinding),
    restated: file.restated.map(withFinding),
    stored: file.stored.map(withFinding),
    tenantExceptions: file.tenant_exceptions,
  };
  const problems = registerProblems(register);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return register;
}

/** Reads docs/adr/denormalization-register.yaml. */
export function loadDenormalizationRegister(path: string = REGISTER_PATH): DenormalizationRegister {
  return parseDenormalizationRegister(readFileSync(path, "utf8"));
}
