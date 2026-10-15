import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { GENERATED_PATH, renderRegistryModule } from "./generate.ts";
import { loadSettingsRegistry } from "./load.ts";
import { renderContributorSql } from "./sql.ts";

/**
 * Settings registry CLI.
 *   generate-cli.ts            writes src/settings/registry.generated.ts
 *   generate-cli.ts --check    exits 1 when the generated module is out of date
 *   generate-cli.ts sql <who>  prints the private.define_setting statements of one contributor
 */
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const target = `${packageRoot}${GENERATED_PATH}`;
const settings = loadSettingsRegistry();
const args = process.argv.slice(2);

if (args[0] === "sql") {
  const contributor = args[1];
  if (!contributor) {
    console.error("Name the contributor, for example: sql a30");
    process.exit(1);
  }
  console.log(renderContributorSql(settings, contributor));
} else {
  const options = (await resolveConfig(target)) ?? {};
  const generated = await format(renderRegistryModule(settings), { ...options, filepath: target });
  if (args.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch (error) {
      console.error(`Cannot read ${GENERATED_PATH}: ${String(error)}`);
      process.exit(1);
    }
    if (current !== generated) {
      console.error(`${GENERATED_PATH} is out of date. Run generate:settings.`);
      process.exit(1);
    }
    console.log(`${GENERATED_PATH} matches the registry files.`);
  } else {
    writeFileSync(target, generated);
    console.log(`Wrote ${GENERATED_PATH}.`);
  }
}
