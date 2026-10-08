import { PARAM_TYPES, type Sitemap } from "./schema";

/** One segment of a route pattern: a lowercase hyphenated slug or a typed `{param}`. */
export type RouteSegment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "param"; readonly name: string; readonly suffix: string };

const STATIC_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PARAM_SEGMENT = /^\{([a-z][A-Za-z0-9]*)\}((?:\.[a-z0-9]+)?)$/;

/** Problems with a route pattern's syntax; empty when the pattern is well formed. */
export function routeSyntaxProblems(pattern: string): string[] {
  if (!pattern.startsWith("/")) return [`route "${pattern}" must start with "/"`];
  if (pattern === "/") return [];
  const problems: string[] = [];
  for (const segment of pattern.slice(1).split("/")) {
    if (!STATIC_SEGMENT.test(segment) && !PARAM_SEGMENT.test(segment)) {
      problems.push(
        `route "${pattern}" has segment "${segment}" that is neither a lowercase hyphenated slug nor a {param}`,
      );
    }
  }
  return problems;
}

/** Split a well-formed pattern into segments. */
export function parseRoute(pattern: string): RouteSegment[] {
  if (pattern === "/") return [];
  return pattern
    .slice(1)
    .split("/")
    .map((segment): RouteSegment => {
      const param = PARAM_SEGMENT.exec(segment);
      return param
        ? { kind: "param", name: param[1] ?? "", suffix: param[2] ?? "" }
        : { kind: "static", value: segment };
    });
}

/** Parameter names in order of appearance. */
export function routeParams(pattern: string): string[] {
  return parseRoute(pattern).flatMap((s) => (s.kind === "param" ? [s.name] : []));
}

type ParamRegistry = Sitemap["params"];

function paramAccepts(registry: ParamRegistry, name: string, value: string): boolean {
  const def = registry[name];
  if (!def) return false;
  if (def.reserved?.includes(value)) return false;
  return PARAM_TYPES[def.type].test(value);
}

function stripPath(path: string): string[] {
  const bare = path.split(/[?#]/, 1)[0] ?? "";
  const trimmed = bare.length > 1 && bare.endsWith("/") ? bare.slice(0, -1) : bare;
  if (trimmed === "/" || trimmed === "") return [];
  return trimmed.slice(1).split("/").map(decodeURIComponent);
}

/** Match a concrete path against a pattern; returns the captured params or null. */
export function matchRoute(
  pattern: string,
  path: string,
  registry: ParamRegistry,
): Record<string, string> | null {
  const segments = parseRoute(pattern);
  const parts = stripPath(path);
  if (segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (const [i, segment] of segments.entries()) {
    const part = parts[i] ?? "";
    if (segment.kind === "static") {
      if (segment.value !== part) return null;
      continue;
    }
    if (!part.endsWith(segment.suffix)) return null;
    const value = part.slice(0, part.length - segment.suffix.length);
    if (!paramAccepts(registry, segment.name, value)) return null;
    params[segment.name] = value;
  }
  return params;
}

/** Static segments outrank params, position by position from the left. */
export function compareSpecificity(a: string, b: string): number {
  const sa = parseRoute(a);
  const sb = parseRoute(b);
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const wa = sa[i]?.kind === "static" ? 1 : 0;
    const wb = sb[i]?.kind === "static" ? 1 : 0;
    if (wa !== wb) return wb - wa;
  }
  return 0;
}

/** True when some concrete path could match both patterns. */
export function routesOverlap(a: string, b: string, registry: ParamRegistry): boolean {
  const sa = parseRoute(a);
  const sb = parseRoute(b);
  if (sa.length !== sb.length) return false;
  return sa.every((x, i) => {
    const y = sb[i];
    if (!y) return false;
    if (x.kind === "static" && y.kind === "static") return x.value === y.value;
    if (x.kind === "param" && y.kind === "param") return x.suffix === y.suffix;
    const [stat, param] = x.kind === "static" ? [x, y] : [y, x];
    if (stat.kind !== "static" || param.kind !== "param") return false;
    if (!stat.value.endsWith(param.suffix)) return false;
    const value = stat.value.slice(0, stat.value.length - param.suffix.length);
    return paramAccepts(registry, param.name, value);
  });
}

/** Build a concrete path from a pattern; throws when a param is missing. */
export function fillRoute(pattern: string, params: Readonly<Record<string, string>>): string {
  const segments = parseRoute(pattern).map((s) => {
    if (s.kind === "static") return s.value;
    const value = params[s.name];
    if (value === undefined) throw new Error(`missing route param "${s.name}" for ${pattern}`);
    return `${encodeURIComponent(value)}${s.suffix}`;
  });
  return `/${segments.join("/")}`;
}
