// A59 visual review: contact sheets from the captured screenshots.
//   node contact.mjs review   large sheets for reading (shots/review/, gitignored)
//   node contact.mjs commit   small JPEG sheets to commit (legal/qa/visual-review/sheets/)
// Each tile is the top of one screenshot with its index and route under it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SHOTS, loadSharp } from "./lib.mjs";

const sharp = loadSharp();
const mode = process.argv[2] ?? "review";
const only = process.argv[3];
const OUT = mode === "commit" ? join(ROOT, "legal/qa/visual-review/sheets") : join(SHOTS, "review");
mkdirSync(OUT, { recursive: true });

const PRESET = {
  review: {
    desktop: { tile: 560, crop: 0.75, cols: 3, per: 9 },
    phone: { tile: 250, crop: 2.4, cols: 6, per: 12 },
    quality: 70,
  },
  commit: {
    desktop: { tile: 170, crop: 0.9, cols: 12, per: 400 },
    phone: { tile: 90, crop: 2.6, cols: 20, per: 400 },
    quality: 50,
  },
}[mode];

const esc = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function sheet(items, kind, file, title) {
  const p = PRESET[kind];
  const label = mode === "commit" ? 22 : 30;
  const tileH = Math.round(p.tile * p.crop);
  const cols = Math.min(p.cols, items.length);
  const rows = Math.ceil(items.length / cols);
  const head = 34;
  const W = cols * (p.tile + 6) + 6;
  const H = head + rows * (tileH + label + 6) + 6;
  const composites = [];
  for (const [i, it] of items.entries()) {
    const x = 6 + (i % cols) * (p.tile + 6);
    const y = head + Math.floor(i / cols) * (tileH + label + 6);
    try {
      const img = sharp(join(SHOTS, it.file));
      const meta = await img.metadata();
      const cropH = Math.min(meta.height, Math.round(meta.width * p.crop));
      const buf = await sharp(join(SHOTS, it.file))
        .extract({ left: 0, top: 0, width: meta.width, height: cropH })
        .resize({
          width: p.tile,
          height: tileH,
          fit: "contain",
          position: "top",
          background: "#808080",
        })
        .toBuffer();
      composites.push({ input: buf, left: x, top: y });
    } catch {
      // A missing shot leaves the tile blank with its label.
    }
    const fs = mode === "commit" ? 9 : 12;
    const svg = `<svg width="${p.tile}" height="${label}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="3" y="${fs + 2}" font-family="Helvetica" font-size="${fs}" fill="#fff">${esc(it.label.slice(0, Math.floor(p.tile / (fs * 0.55))))}</text>${mode === "commit" ? "" : `<text x="3" y="${2 * fs + 4}" font-family="Helvetica" font-size="${fs - 1}" fill="#fc6">${esc((it.note ?? "").slice(0, Math.floor(p.tile / (fs * 0.5))))}</text>`}</svg>`;
    composites.push({ input: Buffer.from(svg), left: x, top: y + tileH });
  }
  const titleSvg = `<svg width="${W}" height="${head}" xmlns="http://www.w3.org/2000/svg"><text x="8" y="23" font-family="Helvetica" font-size="18" fill="#fff">${esc(title)}</text></svg>`;
  composites.push({ input: Buffer.from(titleSvg), left: 0, top: 0 });
  await sharp({ create: { width: W, height: H, channels: 3, background: "#2a2a2a" } })
    .composite(composites)
    .jpeg({ quality: PRESET.quality, mozjpeg: true })
    .toFile(file);
}

const written = [];

/**
 * Committed sheets keep two modes per group so the folder stays small: Atlas in its default dark
 * theme at desktop and light on the phone, Gateway and the states the other way round. Review mode
 * keeps all four.
 */
function keep(group, kind, theme) {
  if (mode !== "commit") return true;
  const darkDesktop = group.startsWith("atlas");
  return kind === "desktop"
    ? (theme === "dark") === darkDesktop
    : (theme === "light") === darkDesktop;
}
async function emit(group, kind, theme, items) {
  const per = PRESET[kind].per;
  for (let s = 0; s * per < items.length; s += 1) {
    const chunk = items.slice(s * per, (s + 1) * per);
    const suffix = items.length > per ? `-${String(s + 1).padStart(2, "0")}` : "";
    const name = `${group}.${kind}.${theme}${suffix}.jpg`;
    await sheet(
      chunk,
      kind,
      join(OUT, name),
      `${group} · ${kind} · ${theme} · ${chunk[0].n}-${chunk.at(-1).n} of ${items.length}`,
    );
    written.push(name);
  }
}

// Route sweeps: shots/<app>-<who>.json
for (const f of readdirSync(SHOTS).filter((f) => /^(atlas|gateway)-[a-z]+\.json$/.test(f))) {
  const group = f.replace(/\.json$/, "");
  if (only && !group.startsWith(only)) continue;
  const data = JSON.parse(readFileSync(join(SHOTS, f), "utf8"));
  for (const kind of ["desktop", "phone"]) {
    for (const theme of ["light", "dark"]) {
      const items = data.results
        .filter((r) => r.viewport === kind && r.shots?.[theme])
        .map((r, i) => ({
          n: i,
          file: r.shots[theme],
          label: `${i} ${r.path.replace(/^\/demo-productions/, "")}`,
          note: [
            r.status !== 200 ? `HTTP ${r.status}` : "",
            r.url !== r.path ? `-> ${r.url}` : "",
            ...(r.checks ?? []),
          ]
            .filter(Boolean)
            .join(" | "),
        }));
      if (items.length && keep(group, kind, theme)) await emit(group, kind, theme, items);
    }
  }
}

// States: shots/states.json
if (existsSync(join(SHOTS, "states.json")) && (!only || only === "states")) {
  const states = JSON.parse(readFileSync(join(SHOTS, "states.json"), "utf8")).filter(
    (r) => r.shots,
  );
  for (const kind of ["desktop", "phone"]) {
    for (const theme of ["light", "dark"]) {
      const items = states
        .filter((r) => r.viewport === kind)
        .map((r, i) => ({
          n: i,
          file: r.shots[theme],
          label: `${r.flow.replace(/^(atlas|gateway)-/, "")} ${r.step}`,
          note: r.error ?? (r.checks ?? []).join(" | "),
        }));
      if (items.length && keep("states", kind, theme)) await emit("states", kind, theme, items);
    }
  }
}

// Workflows: shots/workflows/<run>/steps.json
const wf = join(SHOTS, "workflows");
if (existsSync(wf) && (!only || only === "workflows")) {
  for (const run of readdirSync(wf).filter((d) => existsSync(join(wf, d, "steps.json")))) {
    const steps = JSON.parse(readFileSync(join(wf, run, "steps.json"), "utf8"));
    const items = steps.map((s) => ({
      n: s.n,
      file: s.file,
      label: `${s.n} ${s.action.replace(/internal:|role=|name=|\\"/g, "")}`,
      note: s.error,
    }));
    if (items.length) await emit(`workflow-${run}`, "desktop", "trace", items);
  }
}

// Compass: shots/compass/<flow>/*.png
const cp = join(SHOTS, "compass");
if (existsSync(cp) && (!only || only === "compass")) {
  for (const flow of readdirSync(cp, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const files = readdirSync(join(cp, flow.name))
      .filter((f) => f.endsWith(".png"))
      .sort();
    const items = files.map((f, i) => ({
      n: i,
      file: `compass/${flow.name}/${f}`,
      label: f.replace(/\.png$/, ""),
    }));
    if (items.length) await emit(`compass-${flow.name}`, "phone", "sim", items);
  }
}

writeFileSync(
  join(OUT, mode === "commit" ? "index.json" : "sheets.json"),
  JSON.stringify(written, null, 1),
);
console.log(`${written.length} sheets in ${OUT}`);
