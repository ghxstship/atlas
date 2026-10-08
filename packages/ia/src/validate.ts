import {
  ATLAS_PERSONAS,
  BASIC_VISIBILITY_VALUES,
  EXTERNAL_ROLE_TYPES,
  SCAN_MODES,
  SHELL_ROLES,
  SHELL_VIEWS,
  type Sitemap,
  type Visibility,
} from "./schema";
import { indexSitemap, type IndexedNode } from "./tree";
import { routeParams, routeSyntaxProblems, routesOverlap } from "./routes";
import { effectiveVisibility } from "./visibility";

/** Gate 25: no node deeper than 3 navigation steps from Home. */
export const MAX_DEPTH = 3;

export type IssueCode =
  | "duplicate-id"
  | "label-missing"
  | "route-missing"
  | "route-unexpected"
  | "route-syntax"
  | "route-duplicate"
  | "route-ambiguous"
  | "param-undeclared"
  | "param-unused"
  | "group-empty"
  | "placement"
  | "reference"
  | "audience"
  | "visibility-roles"
  | "visibility-value"
  | "visibility-unresolved"
  | "visibility-unreachable"
  | "compound-visibility"
  | "list"
  | "depth"
  | "home"
  | "chrome"
  | "persona"
  | "level"
  | "twin"
  | "engagement-tabs"
  | "content"
  | "scan"
  | "deep-link";

export interface Issue {
  readonly code: IssueCode;
  readonly message: string;
  readonly nodeId?: string;
}

/** Any object whose nested string leaves are messages (an en-US catalog). */
export type MessageCatalog = { readonly [key: string]: unknown };

export interface ValidateOptions {
  /** The source-locale catalog every label key must resolve in. */
  readonly messages: MessageCatalog;
}

export function hasMessage(messages: MessageCatalog, key: string): boolean {
  let cursor: unknown = messages;
  for (const part of key.split(".")) {
    if (typeof cursor !== "object" || cursor === null || !(part in cursor)) return false;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return typeof cursor === "string" && cursor.length > 0;
}

class Collector {
  readonly issues: Issue[] = [];
  add(code: IssueCode, message: string, nodeId?: string): void {
    this.issues.push(nodeId === undefined ? { code, message } : { code, message, nodeId });
  }
}

function subtree(entry: IndexedNode, all: readonly IndexedNode[]): IndexedNode[] {
  return all.filter((e) => e === entry || e.ancestors.includes(entry));
}

function checkNodes(sitemap: Sitemap, opts: ValidateOptions, out: Collector): void {
  const index = indexSitemap(sitemap);
  const roles = sitemap.audience.roles;
  const allowedViews = new Set(SHELL_VIEWS[sitemap.shell]);

  for (const id of index.duplicateIds) out.add("duplicate-id", `id "${id}" is declared twice`, id);

  for (const entry of index.order) {
    const { node } = entry;
    const id = node.id;
    if (!hasMessage(opts.messages, node.label)) {
      out.add("label-missing", `label key "${node.label}" is not in the en-US catalog`, id);
    }

    if (entry.navigable && node.route === undefined) {
      out.add("route-missing", `${node.kind} "${id}" needs a route`, id);
    }
    if (!entry.navigable && node.route !== undefined) {
      out.add("route-unexpected", `${node.kind} "${id}" must not carry a route`, id);
    }
    if (node.route !== undefined) {
      for (const p of routeSyntaxProblems(node.route)) out.add("route-syntax", p, id);
    }

    if (node.kind === "group") {
      if (!node.children?.length) out.add("group-empty", `group "${id}" has no children`, id);
      if (!node.placement) out.add("placement", `group "${id}" needs a placement`, id);
    } else if (node.placement) {
      out.add("placement", `only groups take a placement ("${id}")`, id);
    }

    for (const ref of [node.twin, node.visibilityFrom]) {
      if (ref !== undefined && !index.byId.has(ref)) {
        out.add("reference", `"${id}" refers to unknown node "${ref}"`, id);
      }
    }

    if (node.visibility) {
      const keys = Object.keys(node.visibility);
      const missing = roles.filter((r) => !keys.includes(r));
      const extra = keys.filter((k) => !roles.includes(k));
      if (missing.length || extra.length) {
        out.add(
          "visibility-roles",
          `"${id}" visibility must name exactly the roles ${roles.join(", ")} (missing: ${missing.join(", ") || "none"}; unknown: ${extra.join(", ") || "none"})`,
          id,
        );
      }
      for (const [role, value] of Object.entries(node.visibility)) {
        if (sitemap.shell !== "atlas" && !BASIC_VISIBILITY_VALUES.includes(value)) {
          out.add(
            "visibility-value",
            `"${id}" uses "${value}" for ${role}; ${sitemap.shell} allows only ${BASIC_VISIBILITY_VALUES.join(", ")}`,
            id,
          );
        }
        checkCompound(entry, value, role, index.order, out);
      }
    }

    if (entry.navigable && (node.auth ?? "session") === "session") {
      for (const role of roles) {
        if (effectiveVisibility(sitemap, id, role) === undefined) {
          out.add("visibility-unresolved", `"${id}" has no visibility for ${role}`, id);
        }
      }
    }

    if (node.list) {
      const { views } = node.list;
      if (!views.includes(node.list.default)) {
        out.add("list", `"${id}" default view "${node.list.default}" is not among its views`, id);
      }
      if (new Set(views).size !== views.length) {
        out.add("list", `"${id}" repeats a view type`, id);
      }
      for (const v of views) {
        if (!allowedViews.has(v)) {
          out.add("list", `"${id}" offers "${v}", which ${sitemap.shell} does not support`, id);
        }
      }
      if (!entry.navigable) out.add("list", `"${id}" is not a route and cannot be a list`, id);
    }

    if (entry.navigable && entry.depth > MAX_DEPTH) {
      out.add(
        "depth",
        `"${id}" is ${entry.depth} steps from Home; the limit is ${MAX_DEPTH} (gate 25)`,
        id,
      );
    }
  }
}

function checkCompound(
  entry: IndexedNode,
  value: Visibility,
  role: string,
  all: readonly IndexedNode[],
  out: Collector,
): void {
  const below = subtree(entry, all);
  const tagged = (tag: string) => below.some((e) => e.node.tags?.includes(tag as never));
  if (value === "full-except-billing-and-legal" && !(tagged("billing") && tagged("legal"))) {
    out.add(
      "compound-visibility",
      `"${entry.node.id}" gives ${role} "full-except-billing-and-legal" but has no billing and legal nodes below it`,
      entry.node.id,
    );
  }
  if (value === "read-and-extend" && !tagged("extensions")) {
    out.add(
      "compound-visibility",
      `"${entry.node.id}" gives ${role} "read-and-extend" but has no extensions node`,
      entry.node.id,
    );
  }
}

function checkReachability(sitemap: Sitemap, out: Collector): void {
  const index = indexSitemap(sitemap);
  for (const entry of index.order) {
    if (!entry.navigable || (entry.node.auth ?? "session") !== "session") continue;
    for (const role of sitemap.audience.roles) {
      const own = effectiveVisibility(sitemap, entry.node.id, role);
      if (own === undefined || own === "hidden") continue;
      const blocked = entry.ancestors.find(
        (a) => a.navigable && effectiveVisibility(sitemap, a.node.id, role) === "hidden",
      );
      if (blocked) {
        out.add(
          "visibility-unreachable",
          `"${entry.node.id}" is visible to ${role} under hidden "${blocked.node.id}"`,
          entry.node.id,
        );
      }
    }
  }
}

function checkRoutes(sitemap: Sitemap, out: Collector): void {
  const index = indexSitemap(sitemap);
  const routed = index.order.filter(
    (e) => e.node.route !== undefined && routeSyntaxProblems(e.node.route).length === 0,
  );
  const used = new Set<string>();
  const seen = new Map<string, string>();
  for (const entry of routed) {
    const route = entry.node.route as string;
    const prior = seen.get(route);
    if (prior) {
      out.add(
        "route-duplicate",
        `route ${route} is used by "${prior}" and "${entry.node.id}"`,
        entry.node.id,
      );
    } else {
      seen.set(route, entry.node.id);
    }
    for (const p of routeParams(route)) {
      used.add(p);
      if (!sitemap.params[p]) {
        out.add("param-undeclared", `route ${route} uses undeclared param {${p}}`, entry.node.id);
      }
    }
  }
  for (const name of Object.keys(sitemap.params)) {
    if (!used.has(name)) out.add("param-unused", `param {${name}} is declared but never used`);
  }
  const unique = [...seen.entries()];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const [a, idA] = unique[i] as [string, string];
      const [b, idB] = unique[j] as [string, string];
      if (routesOverlap(a, b, sitemap.params)) {
        out.add(
          "route-ambiguous",
          `routes ${a} ("${idA}") and ${b} ("${idB}") can match the same path`,
          idB,
        );
      }
    }
  }
}

function checkShellLevel(sitemap: Sitemap, out: Collector): void {
  const index = indexSitemap(sitemap);
  const expected = SHELL_ROLES[sitemap.shell];
  const roles = sitemap.audience.roles;
  if (roles.length !== expected.length || roles.some((r, i) => r !== expected[i])) {
    out.add("audience", `${sitemap.shell} roles must be ${expected.join(", ")} in that order`);
  }
  const home = index.byId.get(sitemap.home);
  if (!home || !home.navigable) out.add("home", `home "${sitemap.home}" must be a routed node`);

  for (const [slot, ids] of Object.entries(sitemap.chrome ?? {})) {
    for (const id of ids) {
      if (!index.byId.has(id)) out.add("chrome", `chrome slot ${slot} names unknown "${id}"`);
    }
  }
}

function checkAtlas(sitemap: Sitemap, out: Collector): void {
  const index = indexSitemap(sitemap);
  const personas = sitemap.personas ?? {};
  for (const persona of ATLAS_PERSONAS) {
    if (!(persona in personas)) {
      out.add("persona", `persona ${persona} needs role-default expanded groups`);
    }
  }
  for (const [persona, groups] of Object.entries(personas)) {
    if (!(ATLAS_PERSONAS as readonly string[]).includes(persona)) {
      out.add("persona", `unknown persona ${persona}`);
    }
    for (const id of groups) {
      const group = index.byId.get(id);
      if (group?.node.kind !== "group" || group.node.placement !== "sidebar") {
        out.add("persona", `persona ${persona} expands "${id}", which is not a sidebar group`);
      }
    }
  }

  const twinned = new Map<string, string[]>();
  for (const entry of index.order) {
    const { node } = entry;
    const inSidebar =
      entry.parent?.node.placement === "sidebar" || entry.parent?.node.placement === "footer";
    if (inSidebar && node.kind === "item" && !node.level) {
      out.add("level", `sidebar item "${node.id}" needs a level (org or both)`, node.id);
    }
    if (node.level && !(inSidebar && node.kind === "item")) {
      out.add("level", `only sidebar items take a level ("${node.id}")`, node.id);
    }
    if (node.twin) {
      const target = index.byId.get(node.twin);
      if (target && target.node.level !== "both") {
        out.add(
          "twin",
          `"${node.id}" twins "${node.twin}", which is not a level-both item`,
          node.id,
        );
      }
      twinned.set(node.twin, [...(twinned.get(node.twin) ?? []), node.id]);
    }
  }
  for (const entry of index.order) {
    if (entry.node.level !== "both") continue;
    const twins = twinned.get(entry.node.id) ?? [];
    if (twins.length !== 1) {
      out.add(
        "twin",
        `level-both item "${entry.node.id}" needs exactly one project tab twin (found ${twins.length})`,
        entry.node.id,
      );
    }
  }
}

function checkGateway(sitemap: Sitemap, out: Collector): void {
  const index = indexSitemap(sitemap);
  const config = sitemap.engagementTabs;
  if (!config) {
    out.add("engagement-tabs", "gateway needs engagement tab sets (Section 4.5.8)");
    return;
  }
  const roleTypes = sitemap.audience.roleTypes ?? [];
  if (
    roleTypes.length !== EXTERNAL_ROLE_TYPES.length ||
    roleTypes.some((r, i) => r !== EXTERNAL_ROLE_TYPES[i])
  ) {
    out.add("audience", `gateway role types must be ${EXTERNAL_ROLE_TYPES.join(", ")}`);
  }
  const container = index.byId.get(config.container);
  const tabIds = new Set((container?.node.children ?? []).map((c) => c.id));
  if (!container || tabIds.size === 0) {
    out.add("engagement-tabs", `container "${config.container}" has no tabs`);
  }
  const used = new Set<string>();
  for (const roleType of EXTERNAL_ROLE_TYPES) {
    const set = config.sets[roleType];
    if (!set) {
      out.add("engagement-tabs", `role type ${roleType} has no engagement tab set`);
      continue;
    }
    const ids =
      "delegatesTo" in set
        ? [...set.tabs, ...set.always, ...Object.values(set.scopes).flat()]
        : set.tabs;
    for (const id of ids) {
      used.add(id);
      if (!tabIds.has(id)) {
        out.add("engagement-tabs", `${roleType} names "${id}", which is not an engagement tab`);
      }
    }
    if (new Set(set.tabs).size !== set.tabs.length) {
      out.add("engagement-tabs", `${roleType} repeats a tab`);
    }
    if ("delegatesTo" in set) {
      const delegated = config.sets[set.delegatesTo];
      const granted = [...set.always, ...Object.values(set.scopes).flat()];
      const expected = delegated?.tabs ?? [];
      const missing = expected.filter((t) => !granted.includes(t));
      const extra = granted.filter((t) => !expected.includes(t));
      if (missing.length || extra.length) {
        out.add(
          "engagement-tabs",
          `${roleType} delegation must cover exactly the ${set.delegatesTo} tabs (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
        );
      }
    } else {
      if (set.tabs[0] !== "engagement.overview") {
        out.add("engagement-tabs", `${roleType} engagements must open to Overview`);
      }
      for (const required of ["engagement.messages", "engagement.documents"]) {
        if (!set.tabs.includes(required)) {
          out.add("engagement-tabs", `${roleType} engagements must carry "${required}"`);
        }
      }
    }
  }
  for (const id of tabIds) {
    if (!used.has(id))
      out.add("engagement-tabs", `engagement tab "${id}" is in no role type's set`);
  }
}

function checkCompass(sitemap: Sitemap, out: Collector, opts: ValidateOptions): void {
  const index = indexSitemap(sitemap);
  const blocks = new Map((sitemap.contentBlocks ?? []).map((b) => [b.id, b.label]));
  for (const [id, label] of blocks) {
    if (!hasMessage(opts.messages, label)) {
      out.add("label-missing", `content block "${id}" label "${label}" is not in the catalog`);
    }
  }
  const profiles = sitemap.contentProfiles ?? {};
  const scan = sitemap.scanContainer ? index.byId.get(sitemap.scanContainer) : undefined;
  if (!scan) out.add("scan", "compass needs a scan container with one child per scan mode");
  const modeNodes = new Map(
    (scan?.node.children ?? []).map((c) => [c.id.split(".").pop() ?? "", c.id]),
  );
  for (const mode of SCAN_MODES) {
    if (scan && !modeNodes.has(mode)) out.add("scan", `scan mode ${mode} has no node`);
  }
  for (const audience of sitemap.audience.roles) {
    const profile = profiles[audience];
    if (!profile) {
      out.add("content", `audience ${audience} has no role-aware content profile`);
      continue;
    }
    for (const block of profile.today) {
      if (!blocks.has(block)) out.add("content", `${audience} shows unknown block "${block}"`);
    }
    const modes = new Set(profile.scanModes.map((m) => m.mode));
    for (const [mode, nodeId] of modeNodes) {
      const visible = effectiveVisibility(sitemap, nodeId, audience) !== "hidden";
      if (visible !== modes.has(mode as never)) {
        out.add(
          "scan",
          `scan mode ${mode} is ${visible ? "visible" : "hidden"} for ${audience} but its content profile ${modes.has(mode as never) ? "lists" : "omits"} it`,
          nodeId,
        );
      }
    }
  }
  for (const key of Object.keys(profiles)) {
    if (!sitemap.audience.roles.includes(key)) out.add("content", `unknown audience ${key}`);
  }
  for (const link of sitemap.deepLinks ?? []) {
    const target = index.byId.get(link.node);
    const linkParams = [...link.pattern.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]);
    const routeParamNames = target?.node.route ? routeParams(target.node.route) : [];
    if (!target?.node.route) {
      out.add("deep-link", `deep link ${link.pattern} targets "${link.node}", which has no route`);
    } else if (linkParams.join(",") !== routeParamNames.join(",")) {
      out.add("deep-link", `deep link ${link.pattern} params differ from ${target.node.route}`);
    }
  }
}

/** Every rule a sitemap must satisfy. Returns an empty list when the sitemap is valid. */
export function validateSitemap(sitemap: Sitemap, opts: ValidateOptions): Issue[] {
  const out = new Collector();
  checkShellLevel(sitemap, out);
  checkNodes(sitemap, opts, out);
  checkReachability(sitemap, out);
  checkRoutes(sitemap, out);
  if (sitemap.shell === "atlas") checkAtlas(sitemap, out);
  if (sitemap.shell === "gateway") checkGateway(sitemap, out);
  if (sitemap.shell === "compass") checkCompass(sitemap, out, opts);
  return out.issues;
}

/** Atlas routes served by another shell must exist there (for example token routes in Gateway). */
export function validateServedBy(from: Sitemap, others: readonly Sitemap[]): Issue[] {
  const out = new Collector();
  for (const entry of indexSitemap(from).order) {
    const { servedBy, route } = entry.node;
    if (!servedBy || route === undefined) continue;
    const host = others.find((s) => s.shell === servedBy);
    const found = host && indexSitemap(host).order.some((e) => e.node.route === route);
    if (!found) {
      out.add(
        "reference",
        `"${entry.node.id}" says ${servedBy} serves ${route}, but the ${servedBy} sitemap has no such route`,
        entry.node.id,
      );
    }
  }
  return out.issues;
}

export function formatIssues(issues: readonly Issue[]): string {
  return issues.map((i) => `[${i.code}] ${i.message}`).join("\n");
}

/** Throw with every issue listed when the sitemap breaks a rule. */
export function assertValidSitemap(sitemap: Sitemap, opts: ValidateOptions): void {
  const issues = validateSitemap(sitemap, opts);
  if (issues.length > 0) {
    throw new Error(
      `${sitemap.shell} sitemap has ${issues.length} issue(s):\n${formatIssues(issues)}`,
    );
  }
}
