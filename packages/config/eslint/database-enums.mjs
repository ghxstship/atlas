/**
 * The database enums as plain lists, read from the Constants block of the generated
 * packages/data/src/database.types.ts. The xos/no-restated-enums rule reads them, and so do the tests
 * of packages that sit below @xos/data in the dependency graph and cannot import Constants: each
 * holds its own copy of an enum equal to the database's (ADR 0123).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const DEFAULT_SOURCE = fileURLToPath(new URL("../../data/src/database.types.ts", import.meta.url));

/**
 * The enums of a database.types source, as { "schema.enum_name": values }. Only the Constants block
 * is read; it is generated as one plain object literal, so each array can be read line by line.
 */
export function enumsFromTypes(source) {
  const start = source.indexOf("export const Constants = {");
  if (start === -1) throw new Error("database.types has no Constants block");
  const end = source.indexOf("} as const;", start);
  const lines = source.slice(start, end).split("\n");
  const enums = {};
  let schema;
  let name;
  let values = [];
  for (const line of lines) {
    const schemaMatch = /^ {2}(\w+): \{/.exec(line);
    if (schemaMatch) {
      schema = schemaMatch[1];
      continue;
    }
    const open = /^ {6}(\w+): \[(.*)$/.exec(line);
    const text = open ? open[2] : line;
    if (open) {
      name = open[1];
      values = [];
    }
    if (name === undefined) continue;
    for (const quoted of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) values.push(JSON.parse(quoted[0]));
    if (/\],?\s*$/.test(text)) {
      enums[`${schema}.${name}`] = values;
      name = undefined;
    }
  }
  return enums;
}

let cached;

/** The repository's database enums, read once per process. */
export function databaseEnums() {
  cached ??= enumsFromTypes(readFileSync(DEFAULT_SOURCE, "utf8"));
  return cached;
}
