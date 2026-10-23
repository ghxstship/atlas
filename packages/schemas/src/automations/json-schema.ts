import { automationJsonSchema } from "./model.ts";

/** The JSON Schema file of an automation definition, beside this package's package.json. */
export const AUTOMATION_SCHEMA_FILE = "automation.schema.json";

/** The file's text before formatting: the JSON Schema of AutomationDefinition. */
export function renderAutomationSchema(): string {
  return `${JSON.stringify(automationJsonSchema(), null, 2)}\n`;
}
