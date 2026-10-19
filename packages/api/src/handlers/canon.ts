/**
 * Canon handlers (A01 canon, A04P handlers). Canon is read through the caller's client
 * (`client.schema("xpms")`), so grants decide access; every resource is read only. Coded lists
 * default to code order (ADR 0003); bridges and derived views page by their natural composite key.
 * The resolvers call xpms.resolve_element and xpms.resolve_gtin and answer NO_ANSWER when nothing
 * matches: they never guess.
 *
 * The Playbook library mirrors, the Roles Library, the canon labor rate cards, supersessions and
 * ratifications read their xpms tables in the shapes corrected in catalog/modules/canon.ts (A50,
 * ADR 0031). canonUrns.resolve calls xpms.urn_resolve, which follows supersessions. The private
 * Production Template and the canon intake staging are not offered (ADR 0031).
 *
 * canonExtensions.propose (A16) records the org's proposal in app.canon_extension_proposals (0490):
 * a discipline under its department or a category under its discipline, in the .50 to .99 range.
 * The proposal is decided in Atlas by someone other than the proposer; xpms is never written.
 */
import type { Components } from "../contract/operations.generated.ts";
import { notFound, refused } from "../problem.ts";
import type { HandlerSet } from "../runtime/handler.ts";
import { proposeCanonExtension } from "@xos/data/canon";
import { requireOrg } from "../runtime/context.ts";
import { created, defineHandlers, ok } from "../runtime/handler.ts";
import { listPage } from "../runtime/listing.ts";
import { selectColumns } from "../runtime/pagination.ts";
import { from, handlersFor, run, tableResource, unwrap } from "./support/table.ts";
import type { TableOptions } from "./support/table.ts";

type Department = Components["CanonDepartment"];

const DEPARTMENT_COLUMNS = ["dept_code", "department", "source", "note"] as const;

/** A read-only canon resource: canon tables never soft-delete. */
const canon = (op: string, options: TableOptions = {}) =>
  handlersFor("Canon", tableResource(op, { softDelete: false, ...options }));

const noAnswer = (reason: string) => refused("NO_ANSWER", reason, "canon_no_match");

export const handlers = defineHandlers("Canon", {
  // Coded list: the default order is numeric code order by dept_code (ADR 0003).
  "canonDepartments.list": async ({ query }, { db }) =>
    ok(
      await listPage<Department>(db.schema("xpms").from("dim_department"), query, {
        columns: DEPARTMENT_COLUMNS,
        key: "dept_code",
        defaultOrder: ["dept_code"],
      }),
    ),

  "canonDepartments.get": async ({ params, query }, { db }) => {
    const columns = selectColumns(query.fields, DEPARTMENT_COLUMNS, "dept_code");
    const { data, error } = await db
      .schema("xpms")
      .from("dim_department")
      .select(columns.join(","))
      .eq("dept_code", String(params.dept_code))
      .maybeSingle();
    if (error !== null) throw error;
    if (data === null) {
      throw notFound(`No department with code ${params.dept_code} is visible to you.`);
    }
    return ok(data as unknown as Department);
  },

  // Dimensions (A04P) ------------------------------------------------------------------------------
  ...canon("canonDisciplines"),
  ...canon("canonCategories"),
  ...canon("canonActs"),
  ...canon("canonPhases"),
  ...canon("canonGateCriteria"),
  ...canon("canonTiers"),
  ...canon("canonTeams"),
  ...canon("canonTags"),
  ...canon("canonTouchpoints"),
  ...canon("canonJurisdictions"),
  ...canon("canonRegions"),
  ...canon("canonRegionMultipliers"),
  ...canon("canonEscalationIndices"),
  ...canon("canonStalenessPolicies"),
  ...canon("canonPermitRules"),
  ...canon("canonMetrics"),
  ...canon("canonIdentifierClasses"),
  ...canon("canonGrains"),
  ...canon("canonProvenances"),
  ...canon("canonFacets"),
  ...canon("canonAssertionRanks"),
  ...canon("canonRecordKinds"),
  ...canon("canonRecordSubtypes"),
  ...canon("canonRecordStates"),
  ...canon("canonRoles"),
  ...canon("canonCounterpartyTypes"),
  ...canon("canonGlAccounts"),
  ...canon("canonCostCenterTemplates"),
  ...canon("canonCategoryGl"),
  ...canon("canonUnitAliases"),
  ...canon("canonUnitDimensions"),
  ...canon("canonUrnNamespaces"),
  ...canon("canonLocales"),
  ...canon("canonStdEmergencyCodes"),
  ...canon("canonStdDocumentLibrary"),
  ...canon("canonStdEnumerations"),
  ...canon("canonStdLaborRateCards"),
  ...canon("canonStdRadioChannels"),
  ...canon("canonStdRoles"),
  ...canon("canonStdSops"),
  ...canon("canonStdVendorClasses"),
  ...canon("canonStdVendorEntitlements"),
  ...canon("canonStdVerbiage"),
  // A code is unique within its domain; lists order by domain, then code.
  ...canon("canonSupersessions", { key: "code" }),
  ...canon("canonRatifications"),
  ...canon("canonVersions"),

  // Elements and their bridges ---------------------------------------------------------------------
  ...canon("canonElements"),
  // One band per element and grade.
  ...canon("canonElementPriceBands", { key: "grade_code" }),
  ...canon("canonElementGtins"),
  ...canon("canonElementPhases", { key: "phase_code" }),
  ...canon("canonElementTags", { key: "tag_id" }),
  ...canon("canonElementPermits", { key: "rule" }),
  ...canon("canonElementMetrics", { key: "item" }),
  ...canon("canonTouchpointDisciplines", { key: "disc_code" }),
  ...canon("canonDisciplineTeams", { key: "team_id" }),

  // Derived views ------------------------------------------------------------------------------------
  ...canon("canonCoordinateMatrix", { key: "phase_code" }),
  ...canon("canonPhaseCoverage"),
  // One row per element and grade.
  ...canon("canonElementEconomics", { key: "grade_code" }),
  ...canon("canonCrosswalkCoverage"),

  // Resolvers ---------------------------------------------------------------------------------------
  "canonUrns.resolve": async ({ query }, { db }) => {
    const rows = await run<
      { kind: string; key: string; resolved_key: string; label: string; is_superseded: boolean }[]
    >(db.schema("xpms").rpc("urn_resolve" as never, { urn: query.urn } as never));
    const row = rows[0];
    if (row === undefined) {
      throw noAnswer(`${query.urn} does not resolve to a canon row.`);
    }
    return ok({ urn: query.urn, ...row });
  },

  "canonElements.resolve": async ({ query }, { db }) => {
    const rows = await run<{ element_id: string; item: string; urid: string; match: string }[]>(
      db.schema("xpms").rpc("resolve_element" as never, { query: query.query } as never),
    );
    const best = rows[0];
    if (best === undefined) {
      throw noAnswer(
        `No catalog element matches "${query.query}". Search the catalog by name instead.`,
      );
    }
    return ok(best);
  },

  "canonExtensions.propose": async ({ body }, context) => {
    const org = requireOrg(context);
    const input = body as {
      proposed_kind: string;
      proposed_code: string;
      proposed_label: string;
      rationale: string;
    };
    const kind = input.proposed_kind.toLowerCase();
    if (kind !== "discipline" && kind !== "category") {
      throw refused("REFUSE", "Propose a discipline or a category.", "canon_extension_kind");
    }
    const level = kind === "discipline" ? "Discipline" : "Category";
    const code = input.proposed_code;
    const parentCode = level === "Discipline" ? code.slice(0, 4) : code.slice(0, 7);
    const proposal = unwrap(
      await proposeCanonExtension(context.db, org.id, {
        level,
        parentCode,
        proposedCode: code,
        label: input.proposed_label,
        rationale: input.rationale,
      }),
    );
    const at = new Date().toISOString();
    return created({
      id: proposal.id,
      created_at: at,
      updated_at: at,
      proposed_kind: kind,
      proposed_code: code,
      proposed_label: input.proposed_label,
      rationale: input.rationale,
      intake_state: "Proposed",
    } as never);
  },

  "canonElementGtins.resolve": async ({ query }, { db }) => {
    const elementId = await run<string | null>(
      db.schema("xpms").rpc("resolve_gtin" as never, { code: query.gtin } as never),
    );
    if (elementId === null) {
      throw noAnswer(`GTIN ${query.gtin} maps to no catalog element.`);
    }
    const element = await run<{ element_id: string; item: string; urid: string } | null>(
      from(db, "elements", "xpms")
        .select("element_id, item, urid")
        .eq("element_id", elementId)
        .maybeSingle(),
    );
    if (element === null) throw noAnswer(`GTIN ${query.gtin} maps to no catalog element.`);
    return ok({ ...element, match: "gtin" });
  },
} satisfies HandlerSet<"Canon">);
