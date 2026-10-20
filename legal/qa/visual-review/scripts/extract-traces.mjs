// A59 visual review: turns each Playwright trace under shots/workflows/<run>/ into numbered step
// screenshots (shots/workflows/<run>/steps/NN-<action>.jpeg) and a steps.json, picking the screencast
// frame painted just after each user action (navigation, click, fill, press, check, select, upload)
// and each assertion that waits on the page.
//   node extract-traces.mjs [run ...]
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SHOTS, slug } from "./lib.mjs";

const root = join(SHOTS, "workflows");
const wanted = process.argv.slice(2);
const STEP =
  /^(goto|click|dblclick|fill|press|pressSequentially|type|check|uncheck|setChecked|selectOption|setInputFiles|tap|hover|expect|reload|goBack|dragTo|waitForURL)$/;

function findTraces(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTraces(p));
    else if (entry.name === "trace.zip") out.push(p);
  }
  return out;
}

for (const run of readdirSync(root, { withFileTypes: true })) {
  if (!run.isDirectory() || (wanted.length && !wanted.includes(run.name))) continue;
  const traces = findTraces(join(root, run.name));
  const stepsDir = join(root, run.name, "steps");
  rmSync(stepsDir, { recursive: true, force: true });
  mkdirSync(stepsDir, { recursive: true });
  const steps = [];
  let n = 0;
  for (const [ti, trace] of traces.entries()) {
    const tmp = join(root, run.name, `.trace-${ti}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp);
    execFileSync("unzip", ["-q", "-o", trace, "-d", tmp]);
    // Each browser context writes its own N-trace.trace with its own clock: pair within a file.
    for (const file of readdirSync(tmp)
      .filter((f) => /^\d+-trace\.trace$/.test(f))
      .sort()) {
      const events = [];
      for (const line of readFileSync(join(tmp, file), "utf8").split("\n")) {
        if (line) events.push(JSON.parse(line));
      }
      const frames = events
        .filter((e) => e.type === "screencast-frame")
        .sort((a, b) => a.timestamp - b.timestamp);
      const ends = new Map(events.filter((e) => e.type === "after").map((e) => [e.callId, e]));
      const actions = events
        .filter((e) => e.type === "before" && STEP.test(e.method ?? ""))
        .map((e) => ({ ...e, end: ends.get(e.callId) }));
      let lastSha = "";
      for (const a of actions) {
        const at = (a.end?.endTime ?? a.startTime) + 250;
        const frame = [...frames].reverse().find((f) => f.timestamp <= at);
        const id = frame?.file ?? frame?.sha1;
        if (!frame || id === lastSha) continue;
        const src = frame.file ? join(tmp, frame.file) : join(tmp, "resources", frame.sha1);
        if (!existsSync(src)) continue;
        lastSha = id;
        n += 1;
        const label =
          `${a.method} ${a.title ?? ""} ${JSON.stringify(a.params?.selector ?? a.params?.url ?? a.params?.expression ?? "")}`
            .replace(/\s+/g, " ")
            .trim();
        const name = `${String(n).padStart(3, "0")}-${slug(`${a.method}-${a.params?.url ?? a.params?.selector ?? a.params?.expression ?? ""}`).slice(0, 60)}.jpeg`;
        copyFileSync(src, join(stepsDir, name));
        steps.push({
          n,
          file: `workflows/${run.name}/steps/${name}`,
          action: label.slice(0, 240),
          error: a.end?.error?.message?.slice(0, 200),
        });
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
  writeFileSync(join(root, run.name, "steps.json"), JSON.stringify(steps, null, 1));
  console.log(`${run.name}: ${traces.length} trace(s), ${steps.length} steps`);
}
