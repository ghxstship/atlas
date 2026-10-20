import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { NOTIFICATION_REGISTRY_MODULE, renderNotificationRegistryModule } from "./generate.ts";
import { loadNotificationRegistry } from "./load.ts";
import {
  NOTIFICATION_KIND_DRIFT_TEST,
  NOTIFICATION_KIND_SEED_MIGRATION,
  renderNotificationDriftTest,
  renderNotificationSeedSql,
} from "./sql.ts";

/**
 * Notification kind registry CLI.
 *   generate-cli.ts           writes the seed migration, its pgTAP drift test and the generated module
 *   generate-cli.ts --check   writes nothing and exits 1 when any of them is out of date
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const registry = loadNotificationRegistry();
const modulePath = `${packageRoot}${NOTIFICATION_REGISTRY_MODULE}`;
const options = (await resolveConfig(modulePath)) ?? {};

const outputs: [string, string, string][] = [
  [
    NOTIFICATION_KIND_SEED_MIGRATION,
    `${repoRoot}${NOTIFICATION_KIND_SEED_MIGRATION}`,
    renderNotificationSeedSql(registry),
  ],
  [
    NOTIFICATION_KIND_DRIFT_TEST,
    `${repoRoot}${NOTIFICATION_KIND_DRIFT_TEST}`,
    renderNotificationDriftTest(registry),
  ],
  [
    `packages/schemas/${NOTIFICATION_REGISTRY_MODULE}`,
    modulePath,
    await format(renderNotificationRegistryModule(registry), { ...options, filepath: modulePath }),
  ],
];

const check = process.argv.includes("--check");
let stale = false;
for (const [label, path, text] of outputs) {
  if (check) {
    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = "";
    }
    if (current !== text) {
      console.error(`${label} is out of date. Run generate:notifications.`);
      stale = true;
    }
  } else {
    writeFileSync(path, text);
    console.log(`Wrote ${label}.`);
  }
}
if (stale) process.exit(1);
if (check) console.log("The notification kind registry outputs match notification-kinds.yaml.");
