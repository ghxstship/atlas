// A59 visual review: tallies the heuristic checks from every route sweep (shots/<app>-<who>.json) and
// prints coverage counts and each flagged visit, grouped by check, for the review and the README.
//   node summarize.mjs [--json]
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SHOTS } from "./lib.mjs";

const files = readdirSync(SHOTS).filter((f) => /^(atlas|gateway)-[a-z]+\.json$/.test(f));
const coverage = [];
const flags = new Map();
const add = (kind, line) => {
  if (!flags.has(kind)) flags.set(kind, []);
  flags.get(kind).push(line);
};
for (const f of files) {
  const data = JSON.parse(readFileSync(join(SHOTS, f), "utf8"));
  const who = f.replace(/\.json$/, "");
  const results = data.results ?? [];
  const routes = new Set(results.map((r) => r.path));
  const shots = results.reduce((n, r) => n + Object.keys(r.shots ?? {}).length, 0);
  coverage.push({ who, routes: routes.size, visits: results.length, shots });
  for (const r of results) {
    const where = `${who} ${r.viewport} ${r.path}`;
    if (r.error) add("error", `${where}: ${r.error}`);
    if (r.status && r.status !== 200) add(`status ${r.status}`, where);
    if (r.url && r.url.split("?")[0] !== r.path.split("?")[0])
      add("redirect", `${where} -> ${r.url}`);
    for (const c of r.checks ?? []) add(c.split(":")[0], `${where}: ${c}`);
    for (const c of r.console ?? []) add("console", `${where}: ${c.slice(0, 160)}`);
  }
}
if (existsSync(join(SHOTS, "states.json"))) {
  const states = JSON.parse(readFileSync(join(SHOTS, "states.json"), "utf8"));
  coverage.push({
    who: "states",
    routes: new Set(states.map((s) => `${s.flow} ${s.step}`)).size,
    visits: states.length,
    shots: states.reduce((n, s) => n + Object.keys(s.shots ?? {}).length, 0),
  });
  for (const s of states)
    if (s.error) add("state error", `${s.flow} ${s.step} ${s.viewport}: ${s.error}`);
}
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ coverage, flags: Object.fromEntries(flags) }, null, 1));
} else {
  console.table(coverage);
  for (const [k, v] of [...flags].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n## ${k} (${v.length})`);
    for (const line of v.slice(0, 60)) console.log(`  ${line}`);
    if (v.length > 60) console.log(`  ... ${v.length - 60} more`);
  }
}
