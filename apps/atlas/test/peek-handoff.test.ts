/**
 * Collection pages and the shell's `?peek` (Section 4.5.3, lib/shell/peek.ts): on a page that peeks
 * its own rows the shell opens the key only when the page hands it over (PeekHandoff), so a page that
 * reads `?peek` and renders nothing for a key it has no row for (a stale link, a record key from
 * elsewhere) shows the list with nothing open. These checks read the source of every page under
 * app/[org] and follow the names each page uses through its local imports, so a new page cannot
 * read `?peek` without handing an unshown key over or answering it with its own not-found state.
 * They also keep row ids out of `?peek` where no record panel would show them (a page with no
 * panel, or one where the shell opens the key itself), whether a query change, a row component or
 * an href written as a template literal puts them there, and keep every read of a `?peek` row by id
 * counting a key that is no id as no row (peekRowMissing).
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

/**
 * Code that reads a `?peek` row by its id. A key that is no id at all (a record key read as a UUID)
 * fails as `invalid`, which peekRowMissing counts as no row, as it counts `not-found`. Every caller
 * of peekRowMissing outside lib/ is listed, so none can go back to comparing the kind with
 * "not-found".
 */
const BY_ID_READERS: Readonly<Record<string, string>> = {
  "app/[org]/crew/pay-periods/page.tsx#Page": "the pay period, handed over when missing",
  "app/[org]/crew/swaps/page.tsx#Page": "the swap, handed over when missing",
  "app/[org]/crew/time-entries/page.tsx#Page": "the time entry, handed over when missing",
  "app/[org]/crew/time-off/page.tsx#Page": "the time-off request, handed over when missing",
  "app/[org]/crew/timesheets/page.tsx#Page": "the timesheet, handed over when missing",
  "app/[org]/people/agreements/page.tsx#Page": "the agreement, handed over when missing",
  "app/[org]/people/certifications/page.tsx#Page": "the certification, handed over when missing",
  "app/[org]/people/requisitions/page.tsx#Page": "the requisition, handed over when missing",
  "components/crew/payroll-run.tsx#PayrollRunRecord": "a pay period's run, none when missing",
  "components/crew/shifts-collection.tsx#ShiftsCollection": "the shift, handed over when missing",
  "components/advancing/packets.tsx#loadPacket": "a packet's full page, 404 when missing",
  "components/advancing/reconciliation.tsx#RunPage": "a run's full page, 404 when missing",
  "components/advancing/riders.tsx#loadRider": "a rider's full page, 404 when missing",
};

/**
 * `?peek` readers on collection pages that compare a failed read's kind with "not-found"
 * themselves: each meets no `invalid` for the key, because it looks the row up by key or reads only
 * a UUID.
 */
const KIND_NOT_FOUND: Readonly<Record<string, string>> = {
  "components/assets/units-view.tsx#UnitsView": "reads the unit by its asset tag",
  "components/logistics-hospitality/beos.tsx#BeosSection": "finds the id by key (findIdByKey)",
  "components/logistics-hospitality/blocks.tsx#BlocksSection": "finds the id by key (findIdByKey)",
  "components/logistics-hospitality/dock.tsx#DockSection": "reads a slot only for a UUID key",
  "components/logistics-hospitality/fulfillments.tsx#FulfillmentsSection":
    "finds the id by key (findIdByKey)",
  "components/logistics-hospitality/shipments.tsx#ShipmentsSection":
    "finds the id by key (findIdByKey)",
  "components/schedule/schedule-pages.tsx#BaselinesPage": "reads a baseline only for a UUID key",
  "components/show/segment-library-page.tsx#SegmentLibraryPage":
    "reads a library segment only for a UUID key",
  "components/show/show-pages.tsx#RunsPage": "reads a running order only for a UUID key",
  // Its comparison is about the door list's read, not the `?peek` row, which it finds in the list.
  "components/workforce/guest-check-in.tsx#GuestCheckInSection": "finds the guest in its list",
};

const atlas = fileURLToPath(new URL("../", import.meta.url));
const orgApp = join(atlas, "app", "[org]");

/** A JSX element a declaration renders. */
interface Rendered {
  readonly tag: string;
  readonly attributes: ReadonlySet<string>;
  /** Passes `activatable={false}`: a row component whose rows open nothing. */
  readonly inert: boolean;
  /** Passes `activatable={activatable}`: a row component that opens rows when its renderer does. */
  readonly forwards: boolean;
}

/** What a declaration does with `?peek`, read from its syntax (peekUse). */
interface PeekUse {
  /** Reads the URL's `?peek`. */
  readonly reads: boolean;
  /**
   * Puts a value in `?peek` of its own page: a query change (`go({ peek: id })`,
   * `q.set("peek", id)`), or an href that sets it on a path it does not spell out
   * (`` `${pathname}?peek=${id}` ``, `` `?peek=${id}` ``, `` `${path}?peek={id}` ``, `"?peek=" + id`).
   */
  readonly writes: boolean;
  /**
   * Hrefs that set `?peek` on a path they spell out (`` `/${org}/crew/shifts?peek=${id}` ``): each
   * path, its substitutions as HOLE, for the page it names to answer for (linkedPage).
   */
  readonly links: readonly string[];
  /** Compares a failed read's kind with "not-found" itself instead of asking peekRowMissing. */
  readonly kindNotFound: boolean;
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

const EQUALITY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const isKind = (e: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(e) && e.name.text === "kind";

/** A template literal's substitution in the text peekUse reads its URL from. */
const HOLE = "\u0000";

/** `?peek=` or `&peek=` given a value: a substitution, or a `{id}` the page fills in later. */
const PEEK_VALUE = new RegExp(`[?&]peek=(?:${HOLE}|\\{)`);

/** `?peek=` or `&peek=` at the end of a literal a value is appended to (`"?peek=" + id`). */
const PEEK_OPEN = /[?&]peek=$/;

/** A template literal's text with each substitution as a HOLE, the way peekUse reads an href. */
const templateText = (n: ts.TemplateExpression): string =>
  n.head.text + n.templateSpans.map((span) => `${HOLE}${span.literal.text}`).join("");

/**
 * The text of each `const` in `node`, then at the top of its file, that holds a string or a template
 * literal (`const pipeline = `/${org}/opportunities/pipeline``), so an href that starts with one
 * names the path it holds.
 */
function constTexts(node: ts.Node): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  const take = (d: ts.VariableDeclaration) => {
    const list = d.parent;
    const value = d.initializer;
    if (!ts.isIdentifier(d.name) || texts.has(d.name.text) || !value) return;
    if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return;
    if (ts.isTemplateExpression(value)) texts.set(d.name.text, templateText(value));
    else if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      texts.set(d.name.text, value.text);
    }
  };
  const walk = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n)) take(n);
    ts.forEachChild(n, walk);
  };
  walk(node);
  for (const stmt of node.getSourceFile().statements) {
    if (ts.isVariableStatement(stmt)) stmt.declarationList.declarations.forEach(take);
  }
  return texts;
}

/** What `node` does with `?peek`, from its syntax alone. */
function peekUse(node: ts.Node): PeekUse {
  let reads = false;
  let writes = false;
  let kindNotFound = false;
  const elements: Rendered[] = [];
  const links: string[] = [];
  const consts = constTexts(node);
  // An href that sets `?peek`: on a path it spells out, a link to that page; else its own page's.
  const href = (text: string) => {
    if (!PEEK_VALUE.test(text)) return;
    const path = text.split(/[?&]/)[0] ?? "";
    if (path.startsWith("/")) links.push(path);
    else writes = true;
  };
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
    // Writes and links: an href built as a template literal, a string or a concatenation.
    if (ts.isTemplateExpression(n)) {
      // `${pipeline}?peek=${id}` names the path the const pipeline holds.
      const [first] = n.templateSpans;
      const lead =
        n.head.text === "" && first && ts.isIdentifier(first.expression)
          ? consts.get(first.expression.text)
          : undefined;
      href(lead === undefined ? templateText(n) : lead + templateText(n).slice(HOLE.length));
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) href(n.text);
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (ts.isStringLiteral(n.left) || ts.isNoSubstitutionTemplateLiteral(n.left)) &&
      PEEK_OPEN.test(n.left.text)
    ) {
      href(`${n.left.text}${HOLE}`);
    }
    if (
      ts.isBinaryExpression(n) &&
      EQUALITY.has(n.operatorToken.kind) &&
      ((isText(n.left, "not-found") && isKind(n.right)) ||
        (isText(n.right, "not-found") && isKind(n.left)))
    ) {
      kindNotFound = true;
    }
    if (
      ts.isCaseClause(n) &&
      isText(n.expression, "not-found") &&
      isKind(n.parent.parent.expression)
    ) {
      kindNotFound = true;
    }
    if (
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
      ts.isIdentifier(n.tagName)
    ) {
      const attributes = new Set<string>();
      let inert = false;
      let forwards = false;
      for (const a of n.attributes.properties) {
        if (!ts.isJsxAttribute(a)) continue;
        const name = a.name.getText();
        attributes.add(name);
        const value =
          a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
        if (name === "activatable" && value?.kind === ts.SyntaxKind.FalseKeyword) inert = true;
        if (name === "activatable" && value && ts.isIdentifier(value) && value.text === name) {
          forwards = true;
        }
      }
      elements.push({ tag: n.tagName.text, attributes, inert, forwards });
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return { reads, writes, links, kindNotFound, elements };
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
  const mod = emptyModule();
  modules.set(file, mod);
  return parseInto(mod, file, readFileSync(file, "utf8"));
}

const emptyModule = (): Module => ({
  declarations: new Map(),
  imports: new Map(),
  exports: new Map(),
  reexports: new Map(),
  stars: [],
});

/** Reads `text` as the source of `file` into `mod`; parse() caches each file's module. */
function parseInto(mod: Module, file: string, text: string): Module {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
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

const FINANCE_COLLECTION = "components/finance/collection.tsx#FinanceCollection";

/**
 * The row components an opener renders with rows but without its own `activatable` (or `false`):
 * where they open rows whatever the page passed the opener.
 */
function dropsActivatable(opener: Declaration): string[] {
  return opener.elements
    .filter((e) => ROWS.some((a) => e.attributes.has(a)) && !e.forwards && !e.inert)
    .filter((e) => rendersOpener(opener, e.tag))
    .map((e) => `${at(opener)} <${e.tag}>`);
}

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
  /** Its path segments, a dynamic one (`[projectKey]`) as itself. */
  readonly segments: readonly string[];
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
  /**
   * The hrefs the page renders that set `?peek` on a path they spell out (`file#name`), each with
   * the page under app/[org] the path names, or null when it names none.
   */
  readonly links: readonly { readonly at: string; readonly page: string | null }[];
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
      segments: page.split("/").filter(Boolean),
      ownsPeek: pageOwnsPeek(`/${route}`),
      readers,
      writes: [...new Set(writes)],
      reached: all,
      linkPaths: [...all]
        .filter((d) => !relative(atlas, d.file).startsWith("lib/"))
        .flatMap((d) => d.links.map((path) => ({ at: at(d), path }))),
    };
  })
  .map(({ linkPaths, ...page }, _i, all) => ({
    ...page,
    links: linkPaths.map((l) => ({ at: l.at, page: linkedPage(all, l.path) })),
  }));

/**
 * The page under app/[org] a link's path names: `/${org}/crew/shifts` is crew/shifts and
 * `/${org}/p/${key}/work` p/[projectKey]/work (a substitution stands for a dynamic segment); null
 * for a path outside the org or no page.
 */
function linkedPage(all: readonly Pick<Page, "page" | "segments">[], path: string): string | null {
  const [lead, org, ...rest] = path.split("/");
  if (lead !== "" || org !== HOLE) return null;
  const segments = rest.filter(Boolean);
  const found = all.find(
    (p) =>
      p.segments.length === segments.length &&
      p.segments.every((s, i) => s === segments[i] || (/^\[.+\]$/.test(s) && segments[i] === HOLE)),
  );
  return found?.page ?? null;
}

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

  it("passes a row component's activatable on to the row components it renders", () => {
    // FinanceCollection takes activatable={false} for a page with no record panel; its table, list
    // and board are where the rows open, so each must get it, or the page's rows open ?peek anyway.
    const openers = [...new Set(pages.flatMap((p) => [...p.reached]))].filter((d) => d.opener);
    expect(openers.flatMap(dropsActivatable)).toEqual([]);
    const finance = openers.find((d) => at(d) === FINANCE_COLLECTION);
    expect(finance, FINANCE_COLLECTION).toBeDefined();
    const kit = finance ? finance.elements.filter((e) => rendersOpener(finance, e.tag)) : [];
    expect(kit.map((e) => e.tag).sort()).toEqual([
      "CollectionBoard",
      "CollectionList",
      "CollectionTable",
    ]);
  });

  it("fails when FinanceCollection stops passing activatable to its table, list or board", () => {
    const file = join(atlas, "components", "finance", "collection.tsx");
    const source = readFileSync(file, "utf8");
    for (const tag of ["CollectionTable", "CollectionList", "CollectionBoard"]) {
      const dropped = source.replace(
        new RegExp(`(<${tag}\\b[^>]*?)\\s*activatable=\\{activatable\\}`),
        "$1",
      );
      expect(dropped, tag).not.toBe(source);
      // The changed source in the same file, so its tags resolve through the same imports.
      const changed = parseInto(emptyModule(), file, dropped).declarations.get("FinanceCollection");
      expect(changed ? dropsActivatable(changed) : null, tag).toEqual([
        `${FINANCE_COLLECTION} <${tag}>`,
      ]);
    }
  });

  it("links no row's id to ?peek of a page with no record panel or where the shell opens it", () => {
    const pageOf = new Map(pages.map((p) => [p.page, p]));
    const wrong = pages.flatMap((p) =>
      p.links.flatMap(({ at: writer, page }) => {
        // A link names a page under app/[org]: a path that names none is a typo.
        if (page === null) return [`${p.page}: ${writer} links to no page`];
        if (page in NO_RECORD_PANEL) return [`${p.page}: ${writer} links a row to ${page}`];
        const target = pageOf.get(page);
        return target && !target.ownsPeek && !(writer in SHELL_KEYS)
          ? [`${p.page}: ${writer} puts a key in ?peek of ${page}, which the shell opens`]
          : [];
      }),
    );
    // Link a page where the shell opens ?peek with record keys only (list the writer in SHELL_KEYS),
    // and a page with no record panel with no ?peek at all.
    expect(wrong).toEqual([]);
    // The guard sees links like these: shifts by id on Swaps, a custom object record by id.
    expect(byPage.get("crew/swaps")?.links).toContainEqual({
      at: "app/[org]/crew/swaps/page.tsx#Page",
      page: "crew/shifts",
    });
    expect(byPage.get("work/all-records")?.links).toContainEqual({
      at: "components/work/related-records.tsx#RelatedRecords",
      page: "objects/[objectKey]",
    });
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

describe("a ?peek row read by its id", () => {
  const declarations = () => [...modules.values()].flatMap((m) => [...m.declarations.values()]);

  it("counts a key that is no id as no row wherever the row is read by id", () => {
    const callers = new Set(
      declarations()
        .filter((d) => !relative(atlas, d.file).startsWith("lib/") && d.names.has("peekRowMissing"))
        .map(at),
    );
    expect([...callers].sort()).toEqual(Object.keys(BY_ID_READERS).sort());
    for (const d of declarations().filter((x) => at(x) in BY_ID_READERS)) {
      expect(d.kindNotFound, `${at(d)} compares the kind with "not-found" itself`).toBe(false);
    }
  });

  it("lets a ?peek reader compare the kind itself only when no key can fail as invalid", () => {
    const readers = new Set(
      pages
        .filter((p) => p.ownsPeek)
        .flatMap((p) => [...p.reached])
        .filter((d) => !relative(atlas, d.file).startsWith("lib/") && d.reads && d.kindNotFound)
        .map(at),
    );
    expect([...readers].sort()).toEqual(Object.keys(KIND_NOT_FOUND).sort());
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

  it("tells a row component given its renderer's activatable from one that is not", () => {
    const [forwarded, dropped, other] = use(
      "<><CollectionList items={items} activatable={activatable} /><CollectionList items={items} /><CollectionList items={items} activatable={open} /></>",
    ).elements;
    expect(forwarded).toMatchObject({ forwards: true, inert: false });
    expect(dropped).toMatchObject({ forwards: false, inert: false });
    expect(other).toMatchObject({ forwards: false, inert: false });
  });

  it("writes ?peek with an href written as a template literal, a string or a concatenation", () => {
    for (const source of [
      "router.push(`${pathname}?peek=${row.id}`);",
      "const href = `?peek=${encodeURIComponent(id)}`;",
      "const next = `${base}?view=list&peek=${id}`;",
      "<Form successHref={`${path}?peek={id}`} />;",
      "const href = '?peek=' + id;",
      'const href = "?peek={id}";',
    ]) {
      expect(use(source).writes, source).toBe(true);
      expect(use(source).links, source).toEqual([]);
    }
    for (const source of [
      "const href = `/${org}/r/${key}`;",
      "const href = `${base}?view=list`;",
      "const cleared = `${pathname}?peek=`;",
      "/** `?peek=<id>` opens the row. */ const a = 1;",
    ]) {
      expect(use(source).writes, source).toBe(false);
      expect(use(source).links, source).toEqual([]);
    }
  });

  it("reads a template-literal href to another path as a link to that page", () => {
    const shifts = use("<Link href={`/${crew.slug}/crew/shifts?peek=${s.shiftId}`} />;");
    expect(shifts).toMatchObject({ writes: false, links: [`/${HOLE}/crew/shifts`] });
    const named = use(
      "const pipeline = `/${org}/opportunities/pipeline`; const a = <Link href={`${pipeline}?peek=${id}`} />;",
    );
    expect(named).toMatchObject({ writes: false, links: [`/${HOLE}/opportunities/pipeline`] });
    const work = use("const href = `/${org}/p/${key}/work?view=list&peek=${id}`;");
    expect(work.links).toEqual([`/${HOLE}/p/${HOLE}/work`]);
    const all = [
      { page: "crew/shifts", segments: ["crew", "shifts"] },
      { page: "p/[projectKey]/work", segments: ["p", "[projectKey]", "work"] },
    ];
    expect(linkedPage(all, `/${HOLE}/crew/shifts`)).toBe("crew/shifts");
    expect(linkedPage(all, `/${HOLE}/p/${HOLE}/work`)).toBe("p/[projectKey]/work");
    expect(linkedPage(all, `/${HOLE}/crew/shift`)).toBeNull();
    expect(linkedPage(all, "/auth/sign-in")).toBeNull();
  });

  it("compares a kind with not-found in an equality or a switch", () => {
    expect(use('if (detail.error.kind !== "not-found") throw detail.error;').kindNotFound).toBe(
      true,
    );
    expect(use('switch (error.kind) { case "not-found": break; }').kindNotFound).toBe(true);
    expect(use("if (!peekRowMissing(detail.error)) throw detail.error;").kindNotFound).toBe(false);
  });
});
