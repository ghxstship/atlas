import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import {
  FIXTURE_PATH,
  MARKDOWN_PATH,
  renderRegisterFixture,
  renderRegisterMarkdown,
} from "./generate.ts";
import { loadDenormalizationRegister } from "./load.ts";

/**
 * Denormalization register CLI.
 *   generate-cli.ts            writes the pgTAP fixture and the Markdown view from docs/adr/denormalization-register.yaml
 *   generate-cli.ts --check    exits 1 when either is out of date
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const register = loadDenormalizationRegister();
const markdownTarget = `${repoRoot}${MARKDOWN_PATH}`;
const outputs: [string, string][] = [
  [FIXTURE_PATH, renderRegisterFixture(register)],
  [
    MARKDOWN_PATH,
    await format(renderRegisterMarkdown(register), {
      ...((await resolveConfig(markdownTarget)) ?? {}),
      filepath: markdownTarget,
    }),
  ],
];

if (process.argv.includes("--check")) {
  let stale = false;
  for (const [path, generated] of outputs) {
    let current = "";
    try {
      current = readFileSync(`${repoRoot}${path}`, "utf8");
    } catch (error) {
      console.error(`Cannot read ${path}: ${String(error)}`);
    }
    if (current !== generated) {
      console.error(`${path} is out of date. Run generate:denormalization.`);
      stale = true;
    }
  }
  if (stale) process.exit(1);
  console.log(`${FIXTURE_PATH} and ${MARKDOWN_PATH} match denormalization-register.yaml.`);
} else {
  for (const [path, generated] of outputs) {
    writeFileSync(`${repoRoot}${path}`, generated);
    console.log(`Wrote ${path}.`);
  }
}
