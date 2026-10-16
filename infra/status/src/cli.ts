/**
 * Builds the static status page from the synthetic check history.
 *
 *   node --experimental-strip-types infra/status/src/cli.ts --history status-data/history.json --out status-site
 *
 * Writes index.html (en-US) and es/index.html (es-US). Run `pnpm --filter @xos/tokens build` first
 * so the token stylesheets exist.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHistory } from "../../synthetics/src/run.ts";
import {
  renderStatusPage,
  type Incident,
  type StatusConfig,
  type StatusMessages,
} from "./render.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const historyPath = argument("--history", "status-data/history.json");
const outDir = argument("--out", "status-site");
const read = (path: string) => readFileSync(join(repo, path), "utf8");

const config = JSON.parse(read("infra/status/status.config.json")) as StatusConfig;
const incidents = JSON.parse(read("infra/status/incidents.json")) as Incident[];
const history = parseHistory(existsSync(historyPath) ? readFileSync(historyPath, "utf8") : null);
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
