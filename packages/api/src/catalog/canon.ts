/**
 * Canon read endpoints (Section 7.2, Section 10.1). Read-only, cached by canon generation.
 */
import { z } from "@hono/zod-openapi";
import { canon, canonCodes } from "@xos/resource-schemas";
import { collectionAction, collectionQuery, numericOrder, resource } from "./define.ts";
import type { ResourceSpec } from "./types.ts";

const c = canon;

const resolveQuery = z.object({
  query: z
    .string()
    .min(1)
    .meta({
      param: { name: "query", in: "query", description: "Free text, MPN or GTIN." },
      example: "stage deck",
    }),
});

const gtinQuery = z.object({
  gtin: z
    .string()
    .regex(/^[0-9]{8,14}$/)
    .meta({
      param: { name: "gtin", in: "query", description: "GTIN to resolve." },
      example: "00012345678905",
    }),
});

const urnQuery = z.object({
  urn: canonCodes.UrnString.meta({
    param: { name: "urn", in: "query", description: "URN to resolve." },
  }),
});

export const canonResources: readonly ResourceSpec[] = [
  resource("Canon", "/canon/departments", c.CanonDepartment, {
    order: numericOrder(
      ["dept_code"],
      [
        { dept_code: "0000", department: "Executive" },
        { dept_code: "4000", department: "Environment" },
      ],
    ),
  }),
  resource("Canon", "/canon/disciplines", c.CanonDiscipline, {
    order: numericOrder(
      ["disc_code"],
      [
        { disc_code: "0000.01", dept_code: "0000", discipline: "Executive Leadership & Strategy" },
        { disc_code: "0000.02", dept_code: "0000", discipline: "Finance & Accounting" },
      ],
    ),
  }),
  resource("Canon", "/canon/categories", c.CanonCategory, {
    order: numericOrder(
      ["cat_urid"],
      [
        { cat_urid: "0000.01.01", disc_code: "0000.01", category: "Production Leadership" },
        { cat_urid: "0000.02.01", disc_code: "0000.02", category: "Production Accounting" },
      ],
    ),
  }),
  resource("Canon", "/canon/acts", c.CanonAct, {
    order: numericOrder(
      ["ordinal"],
      [
        { ordinal: 1, act: "PLAN", gates: "1-3" },
        { ordinal: 2, act: "BUILD", gates: "4-6" },
      ],
    ),
  }),
  resource("Canon", "/canon/phases", c.CanonPhase, {
    order: numericOrder(
      ["gate"],
      [
        { gate: 1, phase_code: "SCP", phase: "Scope", act: "PLAN" },
        { gate: 2, phase_code: "ENG", phase: "Engage", act: "PLAN" },
      ],
    ),
  }),
  resource("Canon", "/canon/gate-criteria", c.CanonGateCriterion, {
    order: numericOrder(
      ["gate", "criterion_id"],
      [
        { gate: 1, criterion_id: "G1.BUDGET_ENVELOPE" },
        { gate: 2, criterion_id: "G2.CONTRACTS" },
      ],
    ),
  }),
  resource("Canon", "/canon/tiers", c.CanonTier, {
    order: numericOrder(
      ["tier_code"],
      [
        { tier_code: "01", tier: "Social" },
        { tier_code: "04", tier: "Physical" },
      ],
    ),
  }),
  resource("Canon", "/canon/teams", c.CanonTeam, {
    order: numericOrder(
      ["team_id"],
      [
        { team_id: "0000-T01", team: "Executive Leadership", rolls_to_dept_code: "0000" },
        { team_id: "0000-T02", team: "Finance & Accounting", rolls_to_dept_code: "0000" },
      ],
    ),
  }),
  resource("Canon", "/canon/tags", c.CanonTag, {
    order: numericOrder(
      ["tag_id"],
      [
        { tag_id: "TAG-001", tag_type: "Sustainability", tag: "ELECTRIC" },
        { tag_id: "TAG-002", tag_type: "Compliance", tag: "OSHA" },
      ],
    ),
  }),
  resource("Canon", "/canon/touchpoints", c.CanonTouchpoint, {
    order: numericOrder(
      ["touchpoint_id"],
      [{ touchpoint_id: "SGT-01" }, { touchpoint_id: "SGT-02" }],
    ),
  }),
  resource("Canon", "/canon/jurisdictions", c.CanonJurisdiction),
  resource("Canon", "/canon/regions", c.CanonRegion),
  resource("Canon", "/canon/region-multipliers", c.CanonRegionMultiplier),
  resource("Canon", "/canon/escalation-indices", c.CanonEscalationIndex),
  resource("Canon", "/canon/staleness-policies", c.CanonStalenessPolicy, {
    order: numericOrder(["age_months_gte"], [{ age_months_gte: 12 }, { age_months_gte: 24 }]),
  }),
  resource("Canon", "/canon/permit-rules", c.CanonPermitRule),
  resource("Canon", "/canon/metrics", c.CanonMetric),
  resource("Canon", "/canon/identifier-classes", c.CanonIdentifierClass),
  resource("Canon", "/canon/grains", c.CanonGrain),
  resource("Canon", "/canon/provenances", c.CanonProvenance),
  resource("Canon", "/canon/facets", c.CanonFacet),
  resource("Canon", "/canon/assertion-ranks", c.CanonAssertionRank),
  resource("Canon", "/canon/record-kinds", c.CanonRecordKind),
  resource("Canon", "/canon/record-subtypes", c.CanonRecordSubtype),
  resource("Canon", "/canon/record-states", c.CanonRecordState),
  resource("Canon", "/canon/roles", c.CanonRole, {
    order: numericOrder(
      ["role_code"],
      [
        { role_code: "0000.50.01", role: "Client sponsorship", dept_code: "0000" },
        { role_code: "0000.50.02", role: "Operator leadership", dept_code: "0000" },
      ],
    ),
  }),
  resource("Canon", "/canon/counterparty-types", c.CanonCounterpartyType),
  resource("Canon", "/canon/gl-accounts", c.CanonGlAccount, {
    order: numericOrder(
      ["account_code"],
      [
        {
          account_code: "1000",
          account_name: "Cash and Bank",
          account_type: "Asset",
          tax_type: "None",
        },
        {
          account_code: "5400",
          account_name: "Environment",
          account_type: "Expense",
          tax_type: "Tax on Purchases",
        },
      ],
    ),
  }),
  resource("Canon", "/canon/cost-center-templates", c.CanonCostCenterTemplate),
  resource("Canon", "/canon/category-gl", c.CanonCategoryGl, {
    order: numericOrder(["cat_urid"], [{ cat_urid: "0000.01.01" }, { cat_urid: "0000.02.01" }]),
  }),
  resource("Canon", "/canon/unit-aliases", c.CanonUnitAlias),
  resource("Canon", "/canon/unit-dimensions", c.CanonUnitDimension),
  resource("Canon", "/canon/urn-namespaces", c.CanonUrnNamespace),
  resource("Canon", "/canon/locales", c.CanonLocale),
  resource("Canon", "/canon/elements", c.CanonElement, {
    order: numericOrder(
      ["element_id"],
      [{ element_id: "0000.51.01-XOS-001" }, { element_id: "4000.01.01-XPMS-001" }],
    ),
    actions: [
      collectionQuery("resolve", {
        summary: "Resolve an element",
        description:
          "Resolves free text, an MPN or a GTIN to a catalog element through `xpms.resolve_element`. No match returns a 422 refusal with `NO_ANSWER`; the resolver never guesses.",
        query: resolveQuery,
        response: c.ElementResolution.read,
      }),
    ],
  }),
  resource("Canon", "/canon/element-price-bands", c.CanonElementPriceBand, {
    verbs: ["list"],
    order: numericOrder(
      ["element_id"],
      [{ element_id: "4000.01.01-XPMS-001" }, { element_id: "4000.01.01-XPMS-002" }],
    ),
  }),
  resource("Canon", "/canon/element-gtins", c.CanonElementGtin, {
    actions: [
      collectionQuery("resolve", {
        summary: "Resolve a GTIN",
        description:
          "Resolves a GTIN to its element through `xpms.resolve_gtin`. Many GTINs map to one element; one GTIN maps to at most one. An unknown GTIN returns a 422 `NO_ANSWER` refusal.",
        query: gtinQuery,
        response: c.ElementResolution.read,
      }),
    ],
  }),
  resource("Canon", "/canon/element-phases", c.CanonElementPhase),
  resource("Canon", "/canon/element-tags", c.CanonElementTag),
  resource("Canon", "/canon/element-permits", c.CanonElementPermit),
  resource("Canon", "/canon/element-metrics", c.CanonElementMetric),
  resource("Canon", "/canon/touchpoint-disciplines", c.CanonTouchpointDiscipline),
  resource("Canon", "/canon/discipline-teams", c.CanonDisciplineTeam),
  resource("Canon", "/canon/std/document-library", c.StdDocument),
  resource("Canon", "/canon/std/emergency-codes", c.StdEmergencyCode, {
    order: numericOrder(["code"], [{ code: "10" }, { code: "20" }]),
  }),
  resource("Canon", "/canon/std/enumerations", c.StdEnumeration),
  resource("Canon", "/canon/std/labor-rate-cards", c.StdLaborRateCard),
  resource("Canon", "/canon/std/radio-channels", c.StdRadioChannel, {
    order: numericOrder(["channel"], [{ channel: 1 }, { channel: 2 }]),
  }),
  resource("Canon", "/canon/std/roles", c.StdRole),
  resource("Canon", "/canon/std/sops", c.StdSop),
  resource("Canon", "/canon/std/vendor-classes", c.StdVendorClass),
  resource("Canon", "/canon/std/vendor-entitlements", c.StdVendorEntitlement),
  resource("Canon", "/canon/std/verbiage", c.StdVerbiage),
  resource("Canon", "/canon/production-templates", c.CanonProductionTemplate),
  resource("Canon", "/canon/supersessions", c.CanonSupersession),
  resource("Canon", "/canon/ratifications", c.CanonRatification),
  resource("Canon", "/canon/versions", c.CanonVersion),
  resource("Canon", "/canon/intake", c.CanonIntake, {
    verbs: ["list", "get", "create"],
    label: "canon intake proposal",
  }),
  resource("Canon", "/canon/coordinate-matrix", c.CoordinateMatrixCell, {
    order: numericOrder(
      ["dept_code", "phase_code"],
      [
        { dept_code: "0000", phase_code: "SCP" },
        { dept_code: "1000", phase_code: "SCP" },
      ],
    ),
  }),
  resource("Canon", "/canon/phase-coverage", c.PhaseCoverage),
  resource("Canon", "/canon/element-economics", c.ElementEconomics),
  resource("Canon", "/canon/crosswalk-coverage", c.CrosswalkCoverage, {
    order: numericOrder(["urid"], [{ urid: "4000.01.01" }, { urid: "4000.01.02" }]),
  }),
  resource("Canon", "/canon/urns", c.UrnResolution, {
    verbs: [],
    actions: [
      collectionQuery("resolve", {
        summary: "Resolve a URN",
        description:
          "Resolves a `urn:xpms` URN to its canon row through `xpms.urn_resolve`. An unknown URN returns a 422 `NO_ANSWER` refusal.",
        query: urnQuery,
      }),
    ],
  }),
  resource("Canon", "/canon/extensions", c.CanonIntake, {
    verbs: [],
    op: "canonExtensions",
    actions: [
      collectionAction("propose", {
        summary: "Propose a tenant canon extension",
        description:
          "Proposes a tenant extension discipline or category in the `.50` to `.99` range, scoped to the caller's org. Codes outside the range are refused.",
        body: c.CanonIntake.create as z.ZodType,
        status: 201,
      }),
    ],
  }),
];
