import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { GENERATED_PATH, renderViewRegistryModule } from "./generate.ts";
import { loadViewRegistry } from "./load.ts";

/**
 * View registry CLI.
 *   generate-cli.ts            writes src/views/registry.generated.ts
 *   generate-cli.ts --check    exits 1 when the generated module is out of date
 */
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const target = `${packageRoot}${GENERATED_PATH}`;
const options = (await resolveConfig(target)) ?? {};
const generated = await format(renderViewRegistryModule(loadViewRegistry()), {
  ...options,
  filepath: target,
});
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch (error) {
    console.error(`Cannot read ${GENERATED_PATH}: ${String(error)}`);
    process.exit(1);
  }
  if (current !== generated) {
    console.error(`${GENERATED_PATH} is out of date. Run generate:views.`);
    process.exit(1);
  }
  console.log(`${GENERATED_PATH} matches views.yaml.`);
} else {
  writeFileSync(target, generated);
  console.log(`Wrote ${GENERATED_PATH}.`);
}
