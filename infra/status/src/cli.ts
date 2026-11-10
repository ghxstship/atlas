/**
 * Builds the static status page from the synthetic check history.
 *
 *   node --experimental-strip-types infra/status/src/cli.ts --history status-data/history.json \
 *     --incidents status-data/incidents.json --out status-site
 *   node --experimental-strip-types infra/status/src/cli.ts --check-incidents status-incidents/incidents.json
 *
 * Writes index.html (en-US) and es/index.html (es-US). Run `pnpm --filter @xos/tokens build` first
 * so the token stylesheets exist. Incidents live on refs/status/incidents, not in the repository, so
 * posting one needs no merge to main (infra/ci/status-incidents.sh). A missing file is no incidents.
 * --check-incidents only validates the file, and exits 1 listing each problem.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHistory } from "../../synthetics/src/run.ts";
import {
  parseIncidents,
  renderStatusPage,
  type StatusConfig,
  type StatusMessages,
} from "./render.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const readIfPresent = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

const checkPath = argument("--check-incidents", "");
if (checkPath !== "") {
  try {
    const count = parseIncidents(readIfPresent(checkPath)).length;
    console.log(`${checkPath}: ${count} incident(s), all valid.`);
    process.exit(0);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

const historyPath = argument("--history", "status-data/history.json");
const incidentsPath = argument("--incidents", "status-data/incidents.json");
const outDir = argument("--out", "status-site");
const read = (path: string) => readFileSync(join(repo, path), "utf8");

const config = JSON.parse(read("infra/status/status.config.json")) as StatusConfig;
const incidents = parseIncidents(readIfPresent(incidentsPath));
const history = parseHistory(readIfPresent(historyPath));
const tokenCss = {
  base: read("packages/tokens/dist/css/base.css"),
  dark: read("packages/tokens/dist/css/theme.dark.css"),
  light: read("packages/tokens/dist/css/theme.light.css"),
};

const pages: ReadonlyArray<{ locale: string; path: string }> = [
  { locale: "en-US", path: "index.html" },
  { locale: "es-US", path: "es/index.html" },
];

for (const page of pages) {
  const messages = JSON.parse(
    read(`packages/i18n/messages/${page.locale}/status.json`),
  ) as StatusMessages;
  const html = renderStatusPage({
    locale: page.locale,
    messages,
    config,
    history,
    incidents,
    now: new Date(),
    tokenCss,
  });
  const target = join(outDir, page.path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, html);
  console.log(`Wrote ${target}`);
}
writeFileSync(join(outDir, "history.json"), `${JSON.stringify(history)}\n`);
