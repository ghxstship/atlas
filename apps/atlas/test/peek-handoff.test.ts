/**
 * Collection pages and the shell's `?peek` (Section 4.5.3, lib/shell/peek.ts): on a page that peeks
 * its own rows the shell opens the key only when the page hands it over (PeekHandoff), so a page that
 * reads `?peek` and renders nothing for a key it has no row for (a stale link, a record key from
 * elsewhere) shows the list with nothing open. These checks read the source of every page under
 * app/[org] and follow the names each page uses through its local imports, so a new page cannot
 * read `?peek` without handing an unshown key over or answering it with its own not-found state.
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

const atlas = fileURLToPath(new URL("../", import.meta.url));
const orgApp = join(atlas, "app", "[org]");

/** A top-level declaration: its source and the names it uses. */
interface Declaration {
  readonly file: string;
  readonly name: string;
  readonly text: string;
  readonly names: ReadonlySet<string>;
  /** Modules it imports with `import()`, followed whole. */
  readonly loads: readonly string[];
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
  const declare = (declared: readonly string[], node: ts.Node) => {
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
    for (const name of declared) mod.declarations.set(name, { file, name, text, names, loads });
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
      declare([name], stmt);
      if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
        mod.exports.set(hasModifier(stmt, ts.SyntaxKind.DefaultKeyword) ? "default" : name, name);
      }
    } else if (ts.isVariableStatement(stmt)) {
      const names = stmt.declarationList.declarations.flatMap((d) => bindingNames(d.name));
      declare(names, stmt);
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

const reached = new Map<Declaration, ReadonlySet<Declaration>>();

/** Every declaration `start` runs or renders: the names it uses, followed across local modules. */
function reach(start: Declaration): ReadonlySet<Declaration> {
  const known = reached.get(start);
  if (known) return known;
  const seen = new Set<Declaration>();
  const queue: Declaration[] = [start];
  const local = (file: string, name: string, hops: number): void => {
    const mod = parse(file);
    const declaration = mod.declarations.get(name);
    if (declaration) queue.push(declaration);
    const imported = mod.imports.get(name);
    if (!declaration && imported && hops < 20) exported(imported.from, imported.name, hops + 1);
  };
  const exported = (file: string, name: string, hops: number): void => {
    const mod = parse(file);
    if (name === "*") {
      queue.push(...mod.declarations.values());
      for (const r of mod.reexports.values()) exported(r.from, r.name, hops + 1);
      for (const s of hops < 20 ? mod.stars : []) exported(s, "*", hops + 1);
      return;
    }
    const as = mod.exports.get(name);
    if (as !== undefined) return local(file, as, hops);
    const re = mod.reexports.get(name);
    if (re) return exported(re.from, re.name, hops + 1);
    for (const s of hops < 20 ? mod.stars : []) exported(s, name, hops + 1);
  };
  for (let next = queue.pop(); next; next = queue.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    for (const name of next.names) local(next.file, name, 0);
    for (const file of next.loads) exported(file, "*", 0);
  }
  reached.set(start, seen);
  return seen;
}

/**
 * Reads the URL's `?peek`: `search["peek"]`, `params.get("peek")`, `param(search, "peek")`, or the
 * `peek` of parsed URL state (collectionState, the finance and assets query). lib/ holds the parsers
 * and the shell's own decision, so a page counts where it renders from the key.
 */
const READS_PEEK =
  /[\w\])]\s*\[\s*"peek"\s*\]|\.get\(\s*"peek"\s*\)|\(\s*[\w.]+\s*,\s*"peek"\s*\)|\b(?:state|query|search|searchParams|params)\.peek\b/;
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
}

const pages: readonly Page[] = (readdirSync(orgApp, { recursive: true }) as string[])
  .filter((f) => f === "page.tsx" || f.endsWith("/page.tsx"))
  .sort()
  .map((f) => {
    const page = dirname(f) === "." ? "" : dirname(f);
    const route = ["[org]", ...page.split("/").filter(Boolean)]
      .map((s) => s.replace(/^\[(.+)\]$/, (_m, p: string) => SAMPLE[p] ?? "sample"))
      .join("/");
    const all = new Set(
      [...parse(join(orgApp, f)).declarations.values()].flatMap((d) => [...reach(d)]),
    );
    const readers = [...all]
      .filter((d) => !relative(atlas, d.file).startsWith("lib/") && READS_PEEK.test(d.text))
      .map((d) => ({
        at: `${relative(atlas, d.file)}#${d.name}`,
        handsOff: [...reach(d)].some((r) => HANDS_OFF.test(r.text)),
      }))
      .sort((a, b) => a.at.localeCompare(b.at));
    return { page, ownsPeek: pageOwnsPeek(`/${route}`), readers };
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
