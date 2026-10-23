import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { AUTOMATION_SCHEMA_FILE, renderAutomationSchema } from "./json-schema.ts";

/**
 * Automation JSON Schema CLI (ADR 0047).
 *   generate-cli.ts           writes automation.schema.json from the Zod schemas in model.ts
 *   generate-cli.ts --check   writes nothing and exits 1 when the file is out of date
 */
const path = fileURLToPath(new URL(`../../${AUTOMATION_SCHEMA_FILE}`, import.meta.url));
const options = (await resolveConfig(path)) ?? {};
const text = await format(renderAutomationSchema(), { ...options, filepath: path });

if (process.argv.includes("--check")) {
  let current: string;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = "";
  }
  if (current !== text) {
    console.error(
      `packages/schemas/${AUTOMATION_SCHEMA_FILE} is out of date. Run generate:automations.`,
    );
    process.exit(1);
  }
} else {
  writeFileSync(path, text);
  console.log(`Wrote packages/schemas/${AUTOMATION_SCHEMA_FILE}.`);
}
