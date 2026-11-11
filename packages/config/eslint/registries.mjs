/**
 * Reads the generated registries the registry lints check against (Section 3.15): the capability
 * codes from packages/schemas and an app's sitemap routes. Both live in generated TypeScript
 * modules with no runtime imports; ESLint loads its config with plain Node, so the module is
 * transpiled with the TypeScript compiler and imported from a data URL.
 */

import { Buffer } from "node:buffer";
import { readFileSync, readdirSync } from "node:fs";
import { URL } from "node:url";
import ts from "typescript";

/** Imports a TypeScript module that has no runtime imports. */
export async function importTypeScript(url) {
  const source = readFileSync(url, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  if (/^\s*import\s/m.test(outputText)) {
    throw new Error(
      `${String(url)} has a runtime import; the registry lints read only self-contained modules.`,
    );
  }
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

/** Every capability code in packages/schemas/capabilities.yaml, from its generated module. */
export async function loadCapabilityCodes() {
  const module = await importTypeScript(
    new URL("../../schemas/src/capabilities/codes.generated.ts", import.meta.url),
  );
  return [...module.CAPABILITY_CODES];
}

function collectRoutes(nodes, into) {
  for (const node of nodes ?? []) {
    if (typeof node.route === "string") into.push(node.route);
    collectRoutes(node.children, into);
  }
  return into;
}

/**
 * The route patterns an app serves: every route in `ia/sitemap.generated.ts` and the shell routes
 * outside the sitemap that `ia/routes.config.ts` names (SHELL_ROUTES). `appRoot` is the app's
 * directory URL, ending in a slash.
 */
export async function loadSitemapRoutes(appRoot) {
  const { sitemap } = await importTypeScript(new URL("ia/sitemap.generated.ts", appRoot));
  const config = await importTypeScript(new URL("ia/routes.config.ts", appRoot));
  return [...collectRoutes(sitemap.nodes, []), ...Object.keys(config.SHELL_ROUTES ?? {})];
}

const EXPO_ROUTE_FILE = /\.(?:tsx?|jsx?)$/;

/**
 * The route patterns of an Expo Router app (Compass), read from its `app/` directory, the tree its
 * routes are generated into from ia/sitemap.yaml plus its own screens: groups such as `(tabs)` drop
 * out, `index` names its folder, `[param]` becomes `{param}` and `[...rest]` becomes `{...rest}`.
 * Layouts and `+` files are not routes.
 */
export function loadExpoRoutes(appRoot) {
  const dir = new URL("app/", appRoot);
  const routes = new Set();
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = String(entry).replaceAll("\\", "/");
    if (!EXPO_ROUTE_FILE.test(file)) continue;
    const parts = file.replace(EXPO_ROUTE_FILE, "").split("/");
    const name = parts.at(-1) ?? "";
    if (name.startsWith("_") || name.startsWith("+")) continue;
    const segments = parts
      .filter((part) => !/^\(.*\)$/.test(part))
      .filter((part, i, all) => !(part === "index" && i === all.length - 1))
      .map((part) =>
        part
          .replace(/^\[\.\.\.([A-Za-z][A-Za-z0-9]*)\]$/, "{...$1}")
          .replace(/^\[([A-Za-z][A-Za-z0-9]*)\]$/, "{$1}"),
      );
    routes.add(`/${segments.join("/")}`);
  }
  return [...routes].sort();
}
