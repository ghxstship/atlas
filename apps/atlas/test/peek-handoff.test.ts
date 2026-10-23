/**
 * Collection pages and the shell's `?peek` (Section 4.5.3, lib/shell/peek.ts): on a page that peeks
 * its own rows the shell opens the key only when the page hands it over (PeekHandoff), so a page that
 * reads `?peek` and renders nothing for a key it has no row for (a stale link, a record key from
 * elsewhere) shows the list with nothing open. These checks read the source of every page under
 * app/[org] and follow the names each page uses through its local imports, so a new page cannot
 * read `?peek` without handing an unshown key over or answering it with its own not-found state.
 * They also keep row ids out of `?peek` where no record panel would show them: a page with no
 * panel, or one where the shell opens the key itself.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { pageOwnsPeek } from "@/lib/shell/peek";

/**
 * Code that reads `?peek` and answers a key with no row itself, so it keeps that and never hands the
 * key to the shell. Keyed by the reading declaration (`file#name` under apps/atlas), not the page, so
 * a section added to a project tab beside one of these still has to hand its unshown keys over; each
 * names its not-found state.
 */
const OWN_NOT_FOUND: Readonly<Record<string, string>> = {
  // The assets peek drawer names the key it found no row for (assets.*.notFound).
  "app/[org]/assets/asset-classes/page.tsx#AssetClassesPage":
    "the peek says assets.classes.notFound",
  "app/[org]/assets/custody-ledger/page.tsx#CustodyLedgerPage":
    "the peek says assets.custody.notFound",
  "app/[org]/assets/damage/page.tsx#DamagePage": "the peek says assets.damage.notFound",
  "app/[org]/assets/lots/page.tsx#LotsPage": "the peek says assets.lots.notFound",
  "app/[org]/assets/maintenance/page.tsx#MaintenancePage":
    "the peek says assets.maintenance.notFound",
  "components/assets/units-view.tsx#UnitsView":
    "assets.units.notFound in the peek and on the full page",
  // Credentials and incidents show RecordMissing (credentials.common.recordMissing) with Back to list.
  "components/credentials/sections.tsx#CategoriesSection": "CategoryRecord shows RecordMissing",
  "components/credentials/sections.tsx#IssuedSection": "CredentialRecord shows RecordMissing",
  "components/incidents/sections.tsx#DispatchBoardSection": "IncidentRecord shows RecordMissing",
  "components/incidents/sections.tsx#EmergencyCodesSection": "CodeRecord shows RecordMissing",
  "components/incidents/sections.tsx#IncidentsSection": "IncidentRecord shows RecordMissing",
  "components/incidents/sections.tsx#RadioChannelsSection": "ChannelRecord shows RecordMissing",
  // Logistics and hospitality put a RefusalNotice (common.peekMissing) where the record would be.
  "components/logistics-hospitality/beos.tsx#BeosSection": "BeosSection shows common.peekMissing",
  "components/logistics-hospitality/blocks.tsx#BlocksSection":
    "BlocksSection shows common.peekMissing",
  "components/logistics-hospitality/dock.tsx#DockSection": "DockSection shows common.peekMissing",
  "components/logistics-hospitality/fulfillments.tsx#FulfillmentsSection":
    "FulfillmentsSection shows common.peekMissing",
  "components/logistics-hospitality/shipments.tsx#ShipmentsSection":
    "ShipmentsSection shows common.peekMissing",
  "components/logistics-hospitality/yard.tsx#YardSection": "YardSection shows common.peekMissing",
  // Places and safety open their drawer with places.kit.peekMissing in it.
  "components/places/documents/documents-page.tsx#DocumentsPage":
    "the drawer shows places.kit.peekMissing",
  "components/places/plans/plans-page.tsx#PlansPage": "the drawer shows places.kit.peekMissing",
  "components/places/venues/venues-page.tsx#VenuesPage": "VenueDetail shows places.kit.peekMissing",
  "components/safety/inspections/inspections-page.tsx#InspectionsView":
    "the drawer shows places.kit.peekMissing",
  "components/safety/permits/permits-page.tsx#PermitsView":
    "the drawer shows places.kit.peekMissing",
  "components/safety/templates/templates-page.tsx#TemplatesPage":
    "the drawer shows places.kit.peekMissing",
};

/**
 * Pages whose rows have no record panel. A click on a row there must not put the row's id in
 * `?peek`, where the shell's peek could only say it is no record, so their row components pass
 * `activatable={false}`.
 */
const NO_RECORD_PANEL: Readonly<Record<string, string>> = {
  "finance/year-end": "a 1099-NEC payee row is a person or account id, not a record",
  "finance/chart-of-accounts": "the chart is fixed and read-only; an account code is not a record",
  "finance/universal-posting-line-export": "a posting line previews an export row, not a record",
};

/**
 * Code on a page where the shell opens `?peek` itself (NO_OWN_PEEK_NODES in lib/shell/peek.ts) that
 * puts a key there on purpose: a record key, which the shell's peek opens.
 */
const SHELL_KEYS: Readonly<Record<string, string>> = {
  "components/my-work/my-work-view.tsx#MyWorkView": "a My Work row opens its record key",
};

const atlas = fileURLToPath(new URL("../", import.meta.url));
const orgApp = join(atlas, "app", "[org]");

/** A JSX element a declaration renders. */
interface Rendered {
  readonly tag: string;
  readonly attributes: ReadonlySet<string>;
  /** Passes `activatable={false}`: a row component whose rows open nothing. */
  readonly inert: boolean;
}

/** What a declaration does with `?peek`, read from its syntax (peekUse). */
interface PeekUse {
  /** Reads the URL's `?peek`. */
  readonly reads: boolean;
  /** Puts a value in `?peek` with a query change: `go({ peek: id })`, `q.set("peek", id)`. */
  readonly writes: boolean;
  readonly elements: readonly Rendered[];
}

/** A top-level declaration: its source and the names it uses. */
interface Declaration extends PeekUse {
  readonly file: string;
  readonly name: string;
  readonly text: string;
  readonly names: ReadonlySet<string>;
  /** Modules it imports with `import()`, followed whole. */
  readonly loads: readonly string[];
  /**
   * A shared row component that takes `activatable` (the finance kit's table, list and board, the
   * crew PeekTable): its rows open `?peek` unless the page passes `activatable={false}`.
   */
  readonly opener: boolean;
}

interface Module {
  readonly declarations: Map<string, Declaration>;
  readonly imports: Map<string, { readonly from: string; readonly name: string }>;
  /** Exported name to local name. */
  readonly exports: Map<string, string>;
  readonly reexports: Map<string, { readonly from: string; readonly name: string }>;
  readonly stars: string[];
}

/** A local module (`@/` or relative) as a file; a package is outside the app and not followed. */
function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(atlas, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (base === null) return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}

/** Names of the URL state `?peek` is read from: the search params, the parsed collection query. */
const URL_STATE: ReadonlySet<string> = new Set([
  "state",
  "query",
  "search",
  "searchParams",
  "params",
]);

const isText = (n: ts.Node | undefined, text: string): boolean =>
  n !== undefined &&
  (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
  n.text === text;

/** The key a property or binding names: `peek` in `peek: id`, `"peek": id` or `{ peek }`. */
const keyOf = (n: ts.Node | undefined): string | null =>
  n !== undefined && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : null;

/** URL state: `search`, `page.query`, `await searchParams`, `collectionState(params)`. */
function urlState(e: ts.Expression): boolean {
  if (
    ts.isAwaitExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e)
  ) {
    return urlState(e.expression);
  }
  if (ts.isIdentifier(e)) return URL_STATE.has(e.text);
  if (ts.isPropertyAccessExpression(e)) return URL_STATE.has(e.name.text);
  return ts.isCallExpression(e) && e.arguments.some(urlState);
}

/** A pattern that takes URL state apart: `const { peek } = search`, or `query: { peek }` in one. */
function destructuresUrlState(pattern: ts.ObjectBindingPattern): boolean {
  const owner = pattern.parent;
  if (ts.isVariableDeclaration(owner)) {
    return owner.initializer !== undefined && urlState(owner.initializer);
  }
  if (ts.isBindingElement(owner)) {
    const key = keyOf(owner.propertyName);
    return key !== null && URL_STATE.has(key);
  }
  return false;
}

/** No value: `null`, `undefined` or "", which clear a query value instead of setting it. */
const absent = (e: ts.Expression | undefined): boolean =>
  e === undefined ||
  e.kind === ts.SyntaxKind.NullKeyword ||
  (ts.isIdentifier(e) && e.text === "undefined") ||
  isText(e, "");

/**
 * An object literal passed to a call as a query change (`go({ peek })`, `withQuery(p, { peek })`),
 * alone or spread into one from a branch; not a props object or a value nested under another key.
 */
function queryChange(object: ts.ObjectLiteralExpression): boolean {
  let n: ts.Node = object;
  for (;;) {
    const up = n.parent;
    if (ts.isCallExpression(up) || ts.isNewExpression(up)) {
      return (up.arguments ?? []).some((a) => a === n);
    }
    if (
      ts.isParenthesizedExpression(up) ||
      ts.isConditionalExpression(up) ||
      ts.isBinaryExpression(up) ||
      ts.isSpreadAssignment(up) ||
      ts.isObjectLiteralExpression(up)
    ) {
      n = up;
    } else {
      return false;
    }
  }
}

/** What `node` does with `?peek`, from its syntax alone. */
function peekUse(node: ts.Node): PeekUse {
  let reads = false;
  let writes = false;
  const elements: Rendered[] = [];
  const walk = (n: ts.Node) => {
    // Reads: `search["peek"]`, `params.get("peek")`, `param(search, "peek")`, `state.peek`, and
    // `const { peek } = search` (or `{ peek: key }`, or `{ query: { peek } } = page`).
    if (ts.isElementAccessExpression(n) && isText(n.argumentExpression, "peek")) reads = true;
    if (ts.isCallExpression(n)) {
      const [first, second] = n.arguments;
      const callee = n.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "get" &&
        isText(first, "peek")
      ) {
        reads = true;
      }
      if (
        n.arguments.length === 2 &&
        first !== undefined &&
        (ts.isIdentifier(first) || ts.isPropertyAccessExpression(first)) &&
        isText(second, "peek")
      ) {
        reads = true;
      }
      // Writes: `q.set("peek", id)`.
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "set" &&
        isText(first, "peek") &&
        !absent(second)
      ) {
        writes = true;
      }
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === "peek" && urlState(n.expression)) {
      reads = true;
    }
    if (
      ts.isBindingElement(n) &&
      keyOf(n.propertyName ?? n.name) === "peek" &&
      ts.isObjectBindingPattern(n.parent) &&
      destructuresUrlState(n.parent)
    ) {
      reads = true;
    }
    // Writes: `peek: id` or `{ peek }` in a query change.
    if (
      ts.isPropertyAssignment(n) &&
      keyOf(n.name) === "peek" &&
      !absent(n.initializer) &&
      queryChange(n.parent)
    ) {
      writes = true;
    }
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === "peek" && queryChange(n.parent)) {
      writes = true;
    }
    if (
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
      ts.isIdentifier(n.tagName)
    ) {
      const attributes = new Set<string>();
      let inert = false;
      for (const a of n.attributes.properties) {
        if (!ts.isJsxAttribute(a)) continue;
        const name = a.name.getText();
        attributes.add(name);
        const value =
          a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
        if (name === "activatable" && value?.kind === ts.SyntaxKind.FalseKeyword) inert = true;
      }
      elements.push({ tag: n.tagName.text, attributes, inert });
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return { reads, writes, elements };
}

/** A component whose props include `activatable`, destructured or in a `props` type literal. */
function takesActivatable(stmt: ts.Statement): boolean {
  const fn = ts.isFunctionDeclaration(stmt)
    ? stmt
    : ts.isVariableStatement(stmt)
      ? stmt.declarationList.declarations
          .map((d) => d.initializer)
          .find((i) => i !== undefined && (ts.isArrowFunction(i) || ts.isFunctionExpression(i)))
      : undefined;
  const [props] = fn && ts.isFunctionLike(fn) ? fn.parameters : [];
  if (!props) return false;
  if (
    ts.isObjectBindingPattern(props.name) &&
    props.name.elements.some((e) => keyOf(e.propertyName ?? e.name) === "activatable")
  ) {
    return true;
  }
  return (
    props.type !== undefined &&
    ts.isTypeLiteralNode(props.type) &&
    props.type.members.some((m) => keyOf(m.name) === "activatable")
  );
}

const modules = new Map<string, Module>();

function parse(file: string): Module {
  const known = modules.get(file);
  if (known) return known;
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const mod: Module = {
    declarations: new Map(),
    imports: new Map(),
    exports: new Map(),
    reexports: new Map(),
    stars: [],
  };
  modules.set(file, mod);
  const declare = (declared: readonly string[], node: ts.Node, opener = false) => {
    const names = new Set<string>();
    const loads: string[] = [];
    const walk = (n: ts.Node) => {
      if (ts.isIdentifier(n)) names.add(n.text);
      const [arg] = ts.isCallExpression(n) ? n.arguments : [];
      if (
        ts.isCallExpression(n) &&
        n.expression.kind === ts.SyntaxKind.ImportKeyword &&
        arg &&
        ts.isStringLiteral(arg)
      ) {
        const target = resolveImport(file, arg.text);
        if (target) loads.push(target);
      }
      ts.forEachChild(n, walk);
    };
    walk(node);
    const text = node.getText(sf);
    const use = peekUse(node);
    for (const name of declared) {
      mod.declarations.set(name, { file, name, text, names, loads, opener, ...use });
    }
  };
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      if (!clause || clause.isTypeOnly || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const from = resolveImport(file, stmt.moduleSpecifier.text);
      if (!from) continue;
      if (clause.name) mod.imports.set(clause.name.text, { from, name: "default" });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        mod.imports.set(bindings.name.text, { from, name: "*" });
      } else if (bindings) {
        for (const el of bindings.elements) {
          if (!el.isTypeOnly) {
            mod.imports.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
          }
        }
      }
    } else if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue;
      const from =
        stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? resolveImport(file, stmt.moduleSpecifier.text)
          : null;
      if (!stmt.exportClause) {
        if (from) mod.stars.push(from);
      } else if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          if (el.isTypeOnly) continue;
          if (!stmt.moduleSpecifier) mod.exports.set(el.name.text, local);
          else if (from) mod.reexports.set(el.name.text, { from, name: local });
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      declare(["default"], stmt.expression);
      mod.exports.set("default", "default");
    } else if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      const name = stmt.name?.text ?? "default";
      declare([name], stmt, takesActivatable(stmt));
      if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
        mod.exports.set(hasModifier(stmt, ts.SyntaxKind.DefaultKeyword) ? "default" : name, name);
      }
    } else if (ts.isVariableStatement(stmt)) {
      const names = stmt.declarationList.declarations.flatMap((d) => bindingNames(d.name));
      declare(names, stmt, takesActivatable(stmt));
      if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword))
        for (const n of names) mod.exports.set(n, n);
    } else if (ts.isEnumDeclaration(stmt)) {
      declare([stmt.name.text], stmt);
      if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword))
        mod.exports.set(stmt.name.text, stmt.name.text);
    }
  }
  return mod;
}

/** Adds the declaration `name` names in `file` to `out`: its own, or the one it imports. */
function lookup(file: string, name: string, out: Declaration[], hops = 0): void {
  const mod = parse(file);
  const declaration = mod.declarations.get(name);
  if (declaration) out.push(declaration);
  const imported = mod.imports.get(name);
  if (!declaration && imported && hops < 20) exported(imported.from, imported.name, out, hops + 1);
}

/** Adds what `file` exports as `name` (`*`: every declaration) to `out`. */
function exported(file: string, name: string, out: Declaration[], hops: number): void {
  const mod = parse(file);
  if (name === "*") {
    out.push(...mod.declarations.values());
    for (const r of mod.reexports.values()) exported(r.from, r.name, out, hops + 1);
    for (const s of hops < 20 ? mod.stars : []) exported(s, "*", out, hops + 1);
    return;
  }
  const as = mod.exports.get(name);
  if (as !== undefined) return lookup(file, as, out, hops);
  const re = mod.reexports.get(name);
  if (re) return exported(re.from, re.name, out, hops + 1);
  for (const s of hops < 20 ? mod.stars : []) exported(s, name, out, hops + 1);
}

const reached = new Map<Declaration, ReadonlySet<Declaration>>();
const reachedOutside = new Map<Declaration, ReadonlySet<Declaration>>();

/**
 * Every declaration `start` runs or renders: the names it uses, followed across local modules.
 * Without `intoOpeners` it stops at a row component that takes `activatable` (an opener): what the
 * opener's rows do is decided where it is rendered, by `activatable={false}` or its absence.
 */
function reach(start: Declaration, intoOpeners = true): ReadonlySet<Declaration> {
  const cache = intoOpeners ? reached : reachedOutside;
  const known = cache.get(start);
  if (known) return known;
  const seen = new Set<Declaration>();
  const queue: Declaration[] = [start];
  for (let next = queue.pop(); next; next = queue.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    if (!intoOpeners && next.opener && next !== start) continue;
    for (const name of next.names) lookup(next.file, name, queue);
    for (const file of next.loads) exported(file, "*", queue, 0);
  }
  cache.set(start, seen);
  return seen;
}

/** Whether `<tag>` rendered in `from` is an opener, or loads one lazily (`dynamic(import())`). */
function rendersOpener(from: Declaration, tag: string): boolean {
  const found: Declaration[] = [];
  lookup(from.file, tag, found);
  return found.some(
    (d) =>
      d.opener ||
      d.loads.some((file) =>
        [...parse(file).declarations.values()].some((l) => l.opener && d.names.has(l.name)),
      ),
  );
}

/** Attributes that give a row component rows to show; one rendered without rows opens nothing. */
const ROWS: readonly string[] = ["rows", "items", "listItems", "board", "columns"];

const HANDS_OFF = /<PeekHandoff\b/;

const SAMPLE: Readonly<Record<string, string>> = {
  org: "demo-productions",
  projectKey: "NWS",
  recordKey: "NWS-12",
  viewId: "0192f1e2-7c3a-7b4d-9e8f-000000000001",
  teamId: "0192f1e2-7c3a-7b4d-9e8f-000000000001",
};

interface Page {
  /** The page's directory under app/[org]. */
  readonly page: string;
  /** Whether the shell leaves `?peek` on the page's route to the page (pageOwnsPeek). */
  readonly ownsPeek: boolean;
  /** The declarations the page reaches that read `?peek` (`file#name`), and whether each hands off. */
  readonly readers: readonly { readonly at: string; readonly handsOff: boolean }[];
  /**
   * What the page renders that puts a key in `?peek` on its own route: a query change that sets it
   * (`file#name`), or a row component given rows and left activatable (`file#name <Tag>`).
   */
  readonly writes: readonly string[];
  /** Every declaration the page reaches. */
  readonly reached: ReadonlySet<Declaration>;
}

const at = (d: Declaration) => `${relative(atlas, d.file)}#${d.name}`;

const pages: readonly Page[] = (readdirSync(orgApp, { recursive: true }) as string[])
  .filter((f) => f === "page.tsx" || f.endsWith("/page.tsx"))
  .sort()
  .map((f) => {
    const page = dirname(f) === "." ? "" : dirname(f);
    const route = ["[org]", ...page.split("/").filter(Boolean)]
      .map((s) => s.replace(/^\[(.+)\]$/, (_m, p: string) => SAMPLE[p] ?? "sample"))
      .join("/");
    const declarations = [...parse(join(orgApp, f)).declarations.values()];
    const all = new Set(declarations.flatMap((d) => [...reach(d)]));
    // lib/ holds the URL parsers and the shell's own decision, so a page counts where it renders.
    const readers = [...all]
      .filter((d) => !relative(atlas, d.file).startsWith("lib/") && d.reads)
      .map((d) => ({ at: at(d), handsOff: [...reach(d)].some((r) => HANDS_OFF.test(r.text)) }))
      .sort((a, b) => a.at.localeCompare(b.at));
    // A row component's writes count where it is rendered, unless given activatable={false}; lib/
    // builds links (peekHref) from keys a page hands it.
    const outside = new Set(declarations.flatMap((d) => [...reach(d, false)]));
    const writes = [...outside]
      .flatMap((d) => [
        ...(d.writes && !d.opener && !relative(atlas, d.file).startsWith("lib/") ? [at(d)] : []),
        ...d.elements
          .filter((e) => !e.inert && ROWS.some((a) => e.attributes.has(a)))
          .filter((e) => !d.opener && rendersOpener(d, e.tag))
          .map((e) => `${at(d)} <${e.tag}>`),
      ])
      .sort();
    return {
      page,
      ownsPeek: pageOwnsPeek(`/${route}`),
      readers,
      writes: [...new Set(writes)],
      reached: all,
    };
  });

const byPage = new Map(pages.map((p) => [p.page, p]));

describe("collection pages hand ?peek keys they cannot show to the shell", () => {
  it("finds the pages that read ?peek by following each page's code", () => {
    expect(pages.length).toBeGreaterThan(200);
    for (const page of [
      "crew/timesheets",
      "vendors/directory",
      "work/all-records",
      "assets/units",
    ]) {
      expect(byPage.get(page)?.readers.length, page).toBeGreaterThan(0);
    }
    // A section module serves several pages: only the section a page renders counts.
    expect(byPage.get("credentials/issued")?.readers.length).toBeGreaterThan(0);
    expect(byPage.get("credentials/scan-log")?.readers).toEqual([]);
  });

  it("hands an unshown key over wherever a collection page reads ?peek", () => {
    const silent = pages.flatMap((p) =>
      p.ownsPeek
        ? p.readers
            .filter((r) => !r.handsOff && !(r.at in OWN_NOT_FOUND))
            .map((r) => `${p.page}: ${r.at}`)
        : [],
    );
    // Each reads ?peek and renders nothing for a key with no row: render collectionPeek or
    // PeekHandoff there, or list the reader in OWN_NOT_FOUND with the not-found state it shows.
    expect(silent).toEqual([]);
  });

  it("lists only readers a collection page renders that still answer a key themselves", () => {
    const readers = pages.filter((p) => p.ownsPeek).flatMap((p) => p.readers);
    for (const [at, why] of Object.entries(OWN_NOT_FOUND)) {
      const found = readers.filter((r) => r.at === at);
      expect(found.length, `a collection page renders ${at}`).toBeGreaterThan(0);
      expect(
        found.every((r) => !r.handsOff),
        `${at} still answers a ?peek key itself (${why})`,
      ).toBe(true);
    }
  });

  it("leaves ?peek to the shell on every list page that reads none", () => {
    // The shell waits for a hand-off on a collection page; one that never reads the key never hands
    // it over. Such a page goes in NO_OWN_PEEK_NODES (lib/shell/peek.ts).
    expect(pages.filter((p) => p.ownsPeek && p.readers.length === 0).map((p) => p.page)).toEqual(
      [],
    );
  });

  it("reads ?peek only where the shell leaves the key to the page", () => {
    // Elsewhere the shell opens the key itself, over whatever the page renders for it.
    expect(pages.filter((p) => !p.ownsPeek && p.readers.length > 0).map((p) => p.page)).toEqual([]);
  });
});

describe("rows on a page with no record panel open nothing", () => {
  it("puts no row's id in ?peek on a page with no record panel", () => {
    for (const [page, why] of Object.entries(NO_RECORD_PANEL)) {
      const found = byPage.get(page);
      expect(found, page).toBeDefined();
      // Pass activatable={false} to the page's table, list or board (or FinanceCollection).
      expect(found?.writes, `${page}: ${why}`).toEqual([]);
    }
  });

  it("puts only record keys in ?peek where the shell opens the key itself", () => {
    const writes = pages.flatMap((p) =>
      p.ownsPeek ? [] : p.writes.filter((w) => !(w in SHELL_KEYS)).map((w) => `${p.page}: ${w}`),
    );
    // Each would put a row's id where the shell's peek opens it at once and finds no record: pass
    // activatable={false}, or list a writer of record keys in SHELL_KEYS.
    expect(writes).toEqual([]);
    const writers = new Set(pages.flatMap((p) => (p.ownsPeek ? [] : p.writes)));
    for (const writer of Object.keys(SHELL_KEYS)) expect(writers.has(writer), writer).toBe(true);
  });

  it("gives a finance collection's rows their record panel, or none to open", () => {
    const missing = new Set<string>();
    for (const d of new Set(pages.flatMap((p) => [...p.reached]))) {
      for (const e of d.elements) {
        const target: Declaration[] = [];
        lookup(d.file, e.tag, target);
        if (!target.some((t) => at(t) === "components/finance/collection.tsx#FinanceCollection")) {
          continue;
        }
        // Rows with no `detail` to show must open nothing: FinanceCollection hands their ids over.
        if (ROWS.some((a) => e.attributes.has(a)) && !e.attributes.has("detail") && !e.inert) {
          missing.add(at(d));
        }
      }
    }
    expect([...missing]).toEqual([]);
  });

  it("sees a row component left activatable and a query change that sets ?peek", () => {
    // The finance budgets table (a lazy CollectionTable) and the invoices collection open rows.
    expect(byPage.get("finance/budgets")?.writes).toContain(
      "components/finance/budgets-view.tsx#BudgetsView <CollectionTable>",
    );
    expect(byPage.get("finance/invoices")?.writes).toContain(
      "components/finance/invoices-view.tsx#InvoicesView <FinanceCollection>",
    );
    expect(byPage.get("my-work")?.writes).toEqual([
      "components/my-work/my-work-view.tsx#MyWorkView",
    ]);
  });
});

describe("what the guard counts as reading and writing ?peek", () => {
  const use = (source: string) =>
    peekUse(
      ts.createSourceFile("sample.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    );

  it("reads ?peek by index, getter, helper, URL state or destructuring", () => {
    for (const source of [
      'const key = search["peek"];',
      'const key = params.get("peek");',
      'const key = param(search, "peek");',
      "const key = page.query.peek;",
      "const { peek } = await searchParams;",
      "const { view, peek: key } = state;",
      "const { query: { peek } } = page;",
      "const { peek = null } = collectionState(params);",
    ]) {
      expect(use(source).reads, source).toBe(true);
    }
  });

  it("does not take a panel prop, a renamed binding or a write for a read", () => {
    for (const source of [
      "function Frame({ peek }: { peek: ReactNode }) { return peek; }",
      "const { peek } = props;",
      "const { key: peek } = row;",
      'next.set("peek", key);',
    ]) {
      expect(use(source).reads, source).toBe(false);
    }
  });

  it("writes ?peek with a query change, not with a props object or a cleared key", () => {
    for (const source of [
      "go({ peek: String(row.id) });",
      'q.set("peek", id);',
      "go({ create: null, ...(state.id ? { peek: state.id } : {}) }, true);",
    ]) {
      expect(use(source).writes, source).toBe(true);
    }
    for (const source of [
      "go({ peek: null, full: null });",
      "const frame = <Frame {...(panel ? { peek: panel } : {})} />;",
      "const parsed = { peek: search.peek };",
    ]) {
      expect(use(source).writes, source).toBe(false);
    }
  });

  it("tells a row component given activatable={false} from one left activatable", () => {
    const [open, inert] = use(
      "<><CollectionTable rows={rows} /><CollectionTable rows={rows} activatable={false} /></>",
    ).elements;
    expect(open).toMatchObject({ tag: "CollectionTable", inert: false });
    expect(inert).toMatchObject({ tag: "CollectionTable", inert: true });
  });
});
