/**
 * Canon operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Canon resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Canon resources follow ADR 0023.
 */
import { z } from "@hono/zod-openapi";
import { canonCodes, fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, removeVerbs, setOrder, setTable } from "../correct.ts";
import {
  canonEmergencyProtocolResources,
  canonFieldExposure,
} from "./parts/playbook-field-exposure.ts";

const TITLE_CASE = /^[A-Z0-9][A-Za-z0-9&'/.()-]*( [A-Za-z0-9&'/.()-]+)*$/;

/** A canon display value: Title Case text read from an xpms table. */
const canonLabel = (description: string, example: string) =>
  z.string().regex(TITLE_CASE).meta({ description, example });

const flag = (description: string, example = false) => ({
  schema: fields.bool(description, example),
});

// Playbook library mirrors (A50, ADR 0032) -----------------------------------------------------------
// The Standard Library sheets are mirrored cell for cell in xpms (0105): every cell is nullable text,
// and the row is keyed by the sheet's RECORD ID (SOP ID for SOPs). The shapes below are those columns,
// leaving out the sheet bookkeeping (source row, flag, created by, created and updated at).

const cell = (description: string, example: string, max = 20000) => ({
  schema: orNull(fields.text(description, example, max)),
});
const numberCell = (description: string, example: number) => ({
  schema: orNull(z.number().meta({ description, example })),
});
const boolCell = (description: string, example: boolean) => ({
  schema: orNull(z.boolean().meta({ description, example })),
});
const dateCell = (description: string) => ({ schema: orNull(fields.date(description)) });

/** The department, category, sub-category, status and notes columns every library sheet carries. */
const sheetColumns = {
  department: cell("Department as the sheet names it.", "5000 Production", 200),
  category: cell("Category code or name as the sheet gives it.", "5000.05.02", 200),
  sub_category: cell("Sub-category as the sheet names it.", "Overhead Rigging", 200),
  status: cell("Row status in the sheet.", "Active", 200),
  notes: cell("Notes in the sheet.", "Primary life safety and incident response"),
};

const MIRROR = "1.0.0-draft.2";
const mirrorReason = (table: string, sheet: string) =>
  `${table} (0105) mirrors the Playbook ${sheet} sheet cell for cell: the row is keyed by its RECORD ID and every other cell is nullable text, number or boolean as the sheet holds it. The frozen shape named fields the sheet does not have. ADR 0023 left these mirrors for the canon owner; their columns are fixed by the import (Section 2.1), so the shape follows them (ADR 0032).`;

export const additions = defineAdditions("Canon", {
  resources: [...canonEmergencyProtocolResources],
  corrections: [
    {
      id: "canon-act-code",
      since: "1.0.0-draft.2",
      resources: ["canonActs"],
      change: "The key `act` becomes `act_code` (path parameter included); removes `gates`.",
      reason:
        "xpms.dim_act (0101) keys acts by `act_code` and stores no gate list: phases carry their act and gate (xpms.dim_phase).",
      apply: editShape({ rename: { act: "act_code" }, remove: ["gates"] }),
    },
    {
      id: "canon-phase-act-code",
      since: "1.0.0-draft.2",
      resources: ["canonPhases"],
      change: "`act` becomes `act_code`; adds `is_redefined`.",
      reason:
        "xpms.dim_phase (0101) names the act column `act_code` and marks phases whose code 4.0 kept but redefined (`is_redefined`).",
      apply: editShape({
        rename: { act: "act_code" },
        add: {
          is_redefined: flag("True when 4.0 kept the code but redefined the phase (Advance)."),
        },
      }),
    },
    {
      id: "canon-gate-criterion-blocking",
      since: "1.0.0-draft.2",
      resources: ["canonGateCriteria"],
      change: "`blocking` becomes `is_blocking`.",
      reason: "xpms.dim_gate_criterion (0101) names the flag `is_blocking`.",
      apply: editShape({ rename: { blocking: "is_blocking" } }),
    },
    {
      id: "canon-team-department",
      since: "1.0.0-draft.2",
      resources: ["canonTeams"],
      change:
        "`rolls_to_dept_code` becomes `dept_code`; adds `workgroup_tag`, `lead_role` and `responsibilities`.",
      reason:
        "xpms.dim_team (0101) names the department column `dept_code` and carries the workgroup tag, lead role and responsibilities of the Playbook Teams sheet.",
      apply: editShape({
        rename: { rolls_to_dept_code: "dept_code" },
        add: {
          workgroup_tag: { schema: orNull(fields.text("Workgroup tag.", "FOH")) },
          lead_role: {
            schema: orNull(fields.text("Lead role of the team.", "Production Manager")),
          },
          responsibilities: {
            schema: orNull(
              fields.text("What the team is responsible for.", "Front of house operations.", 4000),
            ),
          },
        },
      }),
    },
    {
      id: "canon-jurisdiction-table",
      since: "1.0.0-draft.2",
      resources: ["canonJurisdictions"],
      change:
        "The resource reads `xpms.jurisdiction`; `unit_system` and `currency` become nullable (inherited from the country); removes `primary_code_sets`.",
      reason:
        "Jurisdictions are xpms.jurisdiction (0101); there is no dim_jurisdiction table. A lower level leaves `unit_system` and `currency` NULL to inherit them, and code sets are rows of xpms.jurisdiction_code_set.",
      apply: all(
        setTable("xpms.jurisdiction"),
        editShape({ nullable: ["unit_system", "currency"], remove: ["primary_code_sets"] }),
      ),
    },
    {
      id: "canon-region-currency",
      since: "1.0.0-draft.2",
      resources: ["canonRegions"],
      change: "`currency` becomes `currency_code`; removes `cost_multiplier` and `basis`.",
      reason:
        "xpms.dim_region (0101) names the column `currency_code`; the cost multiplier and the basis flag are columns of xpms.dim_region_multiplier.",
      apply: editShape({
        rename: { currency: "currency_code" },
        remove: ["cost_multiplier", "basis"],
      }),
    },
    {
      id: "canon-region-multiplier-columns",
      since: "1.0.0-draft.2",
      resources: ["canonRegionMultipliers"],
      change: "`multiplier` becomes `cost_multiplier`; `ratified` gives way to `is_basis`.",
      reason:
        "xpms.dim_region_multiplier (0101) stores `cost_multiplier` and marks the basis region the bands were sourced in (`is_basis`); ratification is recorded in xpms.ratification, not on the row.",
      apply: editShape({
        rename: { multiplier: "cost_multiplier" },
        remove: ["ratified"],
        add: { is_basis: flag("True for the basis region the price bands were sourced in.") },
      }),
    },
    {
      id: "canon-staleness-detail-nullable",
      since: "1.0.0-draft.2",
      resources: ["canonStalenessPolicies"],
      change: "`detail` becomes nullable.",
      reason: "xpms.dim_staleness_policy (0101) allows NULL in `detail`.",
      apply: editShape({ nullable: ["detail"] }),
    },
    {
      id: "canon-metric-values",
      since: "1.0.0-draft.2",
      resources: ["canonMetrics"],
      change:
        "`value` becomes the nullable `value_numeric` beside a new `value_text`; `code_derived` and `jurisdiction_neutral` become `is_code_derived` and `is_jurisdiction_neutral`; `source` becomes nullable.",
      reason:
        "xpms.dim_metric (0101) stores a metric as a number or as words (`value_numeric` or `value_text`, either NULL), prefixes its flags with `is_`, and allows NULL in `source`.",
      apply: editShape({
        rename: {
          value: "value_numeric",
          code_derived: "is_code_derived",
          jurisdiction_neutral: "is_jurisdiction_neutral",
        },
        nullable: ["value_numeric", "source"],
        add: {
          value_text: {
            schema: orNull(
              fields.text("Value as text, when canon states it in words.", "Per show day"),
            ),
          },
        },
      }),
    },
    {
      id: "canon-identifier-class-mutable",
      since: "1.0.0-draft.2",
      resources: ["canonIdentifierClasses"],
      change: "`mutable` becomes `is_mutable`.",
      reason: "xpms.dim_identifier_class (0101) names the flag `is_mutable`.",
      apply: editShape({ rename: { mutable: "is_mutable" } }),
    },
    {
      id: "canon-facet-form-nullable",
      since: "1.0.0-draft.2",
      resources: ["canonFacets"],
      change: "`form` becomes nullable.",
      reason: "xpms.dim_facet (0101) allows NULL in `form`.",
      apply: editShape({ nullable: ["form"] }),
    },
    {
      id: "canon-assertion-rank-columns",
      since: "1.0.0-draft.2",
      resources: ["canonAssertionRanks"],
      change: "Removes `economics`, `compliance` and `capability`.",
      reason:
        "xpms.dim_assertion_rank (0101) holds the rank, its meaning and a note; the assertion words per domain are not columns of it.",
      apply: editShape({ remove: ["economics", "compliance", "capability"] }),
    },
    {
      id: "canon-record-subtype-columns",
      since: "1.0.0-draft.2",
      resources: ["canonRecordSubtypes"],
      change: "Removes `gate` and `phase_code`.",
      reason:
        "xpms.dim_record_subtype (0101) pairs a record kind and subtype with its UNSPSC segment; it ties subtypes to no gate or phase.",
      apply: editShape({ remove: ["gate", "phase_code"] }),
    },
    {
      id: "canon-category-gl-cost-center",
      since: "1.0.0-draft.2",
      resources: ["canonCategoryGl"],
      change: "Removes `disc_code`, `dept_code` and `account_code`; adds `default_cost_center`.",
      reason:
        "xpms.dim_category_gl (0101, decision D13) maps a category URID to its default cost center; the discipline, department and GL account are columns of the elements and the GL chart.",
      apply: editShape({
        remove: ["disc_code", "dept_code", "account_code"],
        add: {
          default_cost_center: {
            schema: fields.text("Default cost center (dimension 1) of the category.", "Production"),
          },
        },
      }),
    },
    {
      id: "canon-unit-alias-columns",
      since: "1.0.0-draft.2",
      resources: ["canonUnitAliases"],
      change: "`unit` becomes `unit_code`; adds `dimension_code`.",
      reason:
        "xpms.dim_unit_alias (0101) names the column `unit_code` and records the unit's dimension once ratified (`dimension_code`, nullable).",
      apply: editShape({
        rename: { unit: "unit_code" },
        add: {
          dimension_code: {
            schema: orNull(fields.code("Dimension of the unit, once ratified.", "length")),
          },
        },
      }),
    },
    {
      id: "canon-unit-dimension-catalog",
      since: "1.0.0-draft.2",
      resources: ["canonUnitDimensions"],
      change:
        "A unit dimension is a code and a name: the key becomes `dimension_code` (path parameter included) and adds `name`; removes `unit`.",
      reason:
        "xpms.dim_unit_dimension (0101) lists dimensions by `dimension_code` with a name; units point to their dimension from xpms.dim_unit_alias.",
      apply: editShape({
        key: "dimension_code",
        rename: { dimension: "dimension_code" },
        remove: ["unit"],
        add: {
          dimension_code: { schema: fields.code("Dimension code.", "length") },
          name: { schema: canonLabel("Dimension name.", "Length") },
        },
      }),
    },
    {
      id: "canon-urn-namespace-resolution",
      since: "1.0.0-draft.2",
      resources: ["canonUrnNamespaces"],
      change: "`resolves_to` gives way to `table_name`, `key_column` and `label_column`.",
      reason:
        "xpms.dim_urn_namespace (0101) states how a URN kind resolves as the xpms table, its natural key column and its label column.",
      apply: editShape({
        remove: ["resolves_to"],
        add: {
          table_name: { schema: fields.code("xpms table holding the kind.", "elements") },
          key_column: { schema: fields.code("Natural key column of that table.", "element_id") },
          label_column: { schema: fields.code("Column holding the display label.", "item") },
        },
      }),
    },
    {
      id: "canon-locale-code",
      since: "1.0.0-draft.2",
      resources: ["canonLocales"],
      change:
        "The key `locale` becomes `locale_code` (path parameter included); adds `is_source` and `release_stage`.",
      reason:
        "xpms.dim_locale (0101) keys locales by `locale_code`, marks the source locale and states each locale's release stage (general or beta).",
      apply: editShape({
        rename: { locale: "locale_code" },
        add: {
          is_source: flag("True for the source locale, en-US.", true),
          release_stage: {
            schema: z
              .enum(["general", "beta"])
              .meta({ description: "Release stage.", example: "general" }),
          },
        },
      }),
    },
    {
      id: "canon-element-columns",
      since: "1.0.0-draft.2",
      resources: ["canonElements"],
      change:
        "Removes `grain`; adds `grade`, `description`, `specification`, `tier_code`, `lead_time_hours`, `crew`, `unspsc` and `lifecycle_state`.",
      reason:
        "xpms.elements (0101) has no grain column (grain is the URID's), and carries the experience grade, description, specification, tier, lead time, crew, UNSPSC identifier and lifecycle state of each element.",
      apply: editShape({
        remove: ["grain"],
        add: {
          grade: {
            schema: canonLabel(
              "Experience grade of the element: Standard, Base, Elevated or Premium.",
              "Standard",
            ),
          },
          description: {
            schema: orNull(
              fields.text("Description, sentence case.", "Line array for outdoor stages.", 4000),
            ),
          },
          specification: {
            schema: orNull(fields.text("Specification.", "12 cabinets per side.", 4000)),
          },
          tier_code: { schema: canonCodes.TierCode },
          lead_time_hours: { schema: orNull(fields.quantity("Lead time in hours.", 48)) },
          crew: { schema: orNull(fields.text("Crew the element needs.", "2 audio technicians")) },
          unspsc: {
            schema: orNull(fields.code("UNSPSC identifier; recorded, never minted.", "52161512")),
          },
          lifecycle_state: {
            schema: canonLabel("Lifecycle state from the shared vocabulary.", "Active"),
          },
        },
      }),
    },
    {
      id: "canon-price-band-columns",
      since: "1.0.0-draft.2",
      resources: ["canonElementPriceBands"],
      change:
        "A band is `grade_code`, `amount_minor` and `currency_code` with `assertion_word`; removes `grade`, `unit_price_minor`, `currency`, `assertion_rank`, `effective_confidence` and `region_code`; `valid_from` becomes nullable.",
      reason:
        "xpms.element_price_bands (0101) stores the basis-region amount per price grade with its currency and stated assertion word; regions apply through xpms.dim_region_multiplier, confidence resolves at read time, and `valid_from` may be NULL.",
      apply: editShape({
        nullable: ["valid_from"],
        remove: [
          "grade",
          "unit_price_minor",
          "currency",
          "assertion_rank",
          "effective_confidence",
          "region_code",
        ],
        add: {
          grade_code: { schema: fields.code("Price grade.", "standard") },
          amount_minor: { schema: fields.money("Amount per unit in the basis region.", 125000) },
          currency_code: { schema: fields.currency("ISO 4217 currency of the amount.") },
          assertion_word: {
            schema: orNull(
              fields.text(
                "Economics assertion word; null means canon states none and confidence resolves as no answer.",
                "Quoted",
              ),
            ),
          },
        },
      }),
    },
    {
      id: "canon-version-columns",
      since: "1.0.0-draft.2",
      resources: ["canonVersions"],
      change: "`version` becomes `version_code`; `imported_at` gives way to `bible_generated_at`.",
      reason:
        "xpms.version (0101) names the version `version_code` and records the time the Bible states it was generated, not an import time.",
      apply: editShape({
        rename: { version: "version_code" },
        remove: ["imported_at"],
        add: {
          bible_generated_at: {
            schema: fields.text(
              "Generation time stated in the Bible _generated tab: a wall-clock time without a zone.",
              "2026-10-01 09:00:00",
            ),
          },
        },
      }),
    },
    {
      id: "canon-phase-coverage-columns",
      since: "1.0.0-draft.2",
      resources: ["canonPhaseCoverage"],
      change:
        "Adds `gate`, `phase`, `element_count`, `category_count`, `has_active_element` and `declared_gap_reason`.",
      reason:
        "The view xpms.v_phase_coverage (0104, 1610) reports per phase its gate, label, element and category counts, whether an element is Active, and the declared gap the owner ratified for a phase without one (xpms.declared_gap, owner decision 39) with its reason.",
      apply: editShape({
        add: {
          gate: { schema: orNull(fields.int("Gate ordinal.", 3)) },
          phase: { schema: orNull(canonLabel("Phase label.", "Advance")) },
          element_count: { schema: orNull(fields.int("Elements participating in the phase.", 42)) },
          category_count: {
            schema: orNull(fields.int("Distinct categories among participating elements.", 7)),
          },
          has_active_element: {
            schema: orNull(
              fields.bool("True when at least one participating element is Active.", true),
            ),
          },
          // The example row has an Active element, so it carries no gap and no reason.
          declared_gap_reason: {
            schema: orNull(
              fields.text(
                "Why the phase has no Active element, as its declared gap states it; null without one.",
                "No Scope item is Active yet; the Item Catalog proposes every one.",
              ),
            ).meta({
              description:
                "Why the phase has no Active element, as its declared gap states it; null without one.",
              example: null,
            }),
          },
        },
      }),
    },
    {
      id: "canon-element-economics-columns",
      since: "1.0.0-draft.2",
      resources: ["canonElementEconomics"],
      change:
        "`grade` gives way to `grade_code`, `unit_price_minor` to `amount_minor` and `currency` to `currency_code`; adds `item`, `urid`, `unit_basis`, `assertion_word`, `valid_from`, `valid_to` and `is_unpriced`.",
      reason:
        "The view xpms.v_element_economics (0104) reports each element's band per price grade with the amount, currency, assertion word and validity, and flags grades without a band.",
      apply: editShape({
        rename: { currency: "currency_code" },
        remove: ["grade", "unit_price_minor"],
        add: {
          item: { schema: orNull(fields.text("Item name.", "Line Array")) },
          urid: { schema: orNull(canonCodes.Urid) },
          unit_basis: { schema: orNull(fields.code("Unit basis of the amount.", "day")) },
          grade_code: { schema: orNull(fields.code("Price grade.", "standard")) },
          amount_minor: { schema: fields.money("Amount per unit.", 125000) },
          assertion_word: {
            schema: orNull(fields.text("Stated economics assertion of the band.", "Quoted")),
          },
          valid_from: { schema: orNull(fields.date("Date the band was sourced.")) },
          valid_to: { schema: orNull(fields.date("Date the band stops applying.")) },
          is_unpriced: {
            schema: orNull(fields.bool("True when the element has no band at this grade.", false)),
          },
        },
      }),
    },
    {
      id: "canon-crosswalk-coverage-columns",
      since: "1.0.0-draft.2",
      resources: ["canonCrosswalkCoverage"],
      change:
        "`urid` becomes `cat_urid`; `gtin_mapped_count` gives way to `gtin_element_count` and `gtin_count`; adds `category` and `unspsc_element_count`.",
      reason:
        "The view xpms.v_crosswalk_coverage (0104) reports per category URID its label, element count, elements with an UNSPSC identifier, elements with a confirmed GTIN and the GTIN count.",
      apply: editShape({
        rename: { urid: "cat_urid" },
        remove: ["gtin_mapped_count"],
        nullable: ["cat_urid"],
        add: {
          category: { schema: orNull(canonLabel("Category label.", "Audio")) },
          unspsc_element_count: {
            schema: orNull(fields.int("Elements carrying an UNSPSC identifier.", 12)),
          },
          gtin_element_count: {
            schema: orNull(fields.int("Elements with at least one confirmed GTIN.", 4)),
          },
          gtin_count: {
            schema: orNull(fields.int("Confirmed GTINs bound to elements of the category.", 9)),
          },
        },
      }),
    },
    {
      id: "canon-emergency-code-table",
      since: "1.0.0-draft.2",
      resources: ["canonStdEmergencyCodes"],
      change:
        "The resource reads `xpms.emergency_code`: `name` becomes `label` and `response` becomes `emergency`; adds `swatch` and `sort_order`.",
      reason:
        "Emergency codes are xpms.emergency_code (0101); there is no std_emergency_code table. Each code has its code word, the emergency it announces, its swatch token and its order.",
      apply: all(
        setTable("xpms.emergency_code"),
        editShape({
          rename: { name: "label", response: "emergency" },
          add: {
            swatch: { schema: fields.code("Design token of the swatch.", "ecode-red") },
            sort_order: { schema: fields.int("Order of first appearance in the Playbook.", 1) },
          },
        }),
      ),
    },
    {
      id: "canon-metric-qualifier-text",
      since: "1.0.0-draft.2",
      resources: ["canonMetrics"],
      change: "`qualifier` is free text (nullable), not a code.",
      reason:
        "xpms.dim_metric (0101) stores each metric's qualifier as the code section or modelling note it follows, such as `IBC 1006.2.1 (2 up to 500; 3 to 1,000; 4 above)`, which the code pattern rejects.",
      apply: editShape({
        add: {
          qualifier: {
            schema: orNull(
              fields.text(
                "Qualifier of the value: the code section or modelling note it follows.",
                "IBC 1005.3.2 - 0.2 in per occupant",
                1000,
              ),
            ),
          },
        },
      }),
    },
    {
      id: "canon-facet-since-text",
      since: "1.0.0-draft.2",
      resources: ["canonFacets"],
      change: "`since` is the version as written (nullable text), not a code.",
      reason:
        "xpms.dim_facet (0101) records the introducing version as written in the canon sheet, such as `3.0 (declared)`, which the code pattern rejects.",
      apply: editShape({
        add: {
          since: {
            schema: orNull(
              fields.text("Version that introduced it, as written in canon.", "3.0", 64),
            ),
          },
        },
      }),
    },
    {
      id: "canon-record-subtype-unspsc-text",
      since: "1.0.0-draft.2",
      resources: ["canonRecordSubtypes"],
      change: "`unspsc_segment` is the segment code with its name (nullable text), not a code.",
      reason:
        "xpms.dim_record_subtype (0101) stores the UNSPSC segment as code and name, such as `52160000 Audio and visual equipment and accessories`, which the code pattern rejects.",
      apply: editShape({
        add: {
          unspsc_segment: {
            schema: orNull(
              fields.text(
                "UNSPSC segment code and name.",
                "52160000 Audio and visual equipment and accessories",
                200,
              ),
            ),
          },
        },
      }),
    },
    {
      id: "canon-role-staffing-ratio-number",
      since: "1.0.0-draft.2",
      resources: ["canonRoles"],
      change: "`staffing_ratio` is a number (nullable), not text.",
      reason: "xpms.dim_role (0101) stores the staffing ratio as numeric, such as 250.",
      apply: editShape({
        add: {
          staffing_ratio: {
            schema: orNull(
              z.number().min(0).meta({
                description: "Staffing ratio from canon: how many people one role holder covers.",
                example: 250,
              }),
            ),
          },
        },
      }),
    },
    {
      id: "canon-unit-alias-text",
      since: "1.0.0-draft.2",
      resources: ["canonUnitAliases"],
      change: "`alias` and `unit_code` are text: canon units include phrases such as `lump sum`.",
      reason:
        "xpms.dim_unit_alias (0101) maps units written as phrases with spaces, such as `sq ft per year`, which the code and unit patterns reject.",
      apply: editShape({
        add: {
          alias: { schema: fields.text("Alias as written.", "ea", 64) },
          unit_code: { schema: fields.text("Unit the alias maps to.", "ea", 64) },
        },
      }),
    },
    {
      id: "canon-element-unit-basis-text",
      since: "1.0.0-draft.2",
      resources: ["canonElements"],
      change: "`unit_basis` is text: canon units include phrases such as `lump sum`.",
      reason:
        "xpms.elements (0104) prices some elements per `lump sum` or `sq ft per year`, which the unit pattern rejects.",
      apply: editShape({
        add: { unit_basis: { schema: fields.text("Unit basis of the element.", "ea", 64) } },
      }),
    },
    {
      id: "canon-element-economics-unpriced",
      since: "1.0.0-draft.2",
      resources: ["canonElementEconomics"],
      change:
        "`currency_code` is nullable (an unpriced grade has no currency), `unit_basis` stays nullable, and `effective_confidence` admits NO_ANSWER.",
      reason:
        "The view xpms.v_element_economics (0104) reports grades without a band with a NULL amount and currency, and computes effective confidence as an assertion label or NO_ANSWER, which the label pattern rejects.",
      apply: editShape({
        add: {
          currency_code: {
            schema: orNull(fields.currency("ISO 4217 currency of the amount; null when unpriced.")),
          },
          unit_basis: { schema: orNull(fields.text("Unit basis of the amount.", "day", 64)) },
          effective_confidence: {
            schema: orNull(
              z
                .string()
                .regex(/^[A-Z][A-Z_]*$/)
                .meta({
                  description:
                    "Confidence at read time from the staleness policy: an assertion label, or NO_ANSWER.",
                  example: "QUOTED",
                }),
            ),
          },
        },
      }),
    },
    {
      id: "canon-crosswalk-category-text",
      since: "1.0.0-draft.2",
      resources: ["canonCrosswalkCoverage"],
      change: "`category` is the category name as written (text), not a Title Case label.",
      reason:
        "The view xpms.v_crosswalk_coverage (0104) names categories as canon writes them, such as `FF&E (Furniture, Fixtures & Equipment)`, which the label pattern rejects.",
      apply: editShape({
        add: { category: { schema: fields.text("Category name.", "Production Leadership", 200) } },
      }),
    },

    // A50 (gate 5, RRR-94, ADR 0032) ------------------------------------------------------------------
    {
      id: "canon-std-document-library-columns",
      since: MIRROR,
      resources: ["canonStdDocumentLibrary"],
      change:
        "The key `code` becomes `record_id`; `title` and `urid` give way to the sheet's columns: `document_name`, `document_type`, `reference_id`, `file_format`, `version`, `issue_date`, `expiration_date` and the shared department, category, sub-category, status and notes.",
      reason: mirrorReason("xpms.std_document_library", "Document & Asset Library"),
      apply: editShape({
        rename: { code: "record_id" },
        remove: ["title", "urid"],
        add: {
          document_name: cell("Document name.", "Venue Load-In Guide", 500),
          document_type: cell("Document type.", "Guide", 200),
          reference_id: cell("Reference identifier.", "DOC-004", 200),
          file_format: cell("File format.", "PDF", 100),
          version: cell("Version.", "v2.0", 100),
          issue_date: dateCell("Issue date."),
          expiration_date: dateCell("Expiration date."),
          ...sheetColumns,
        },
      }),
    },
    {
      id: "canon-std-enumeration-columns",
      since: MIRROR,
      resources: ["canonStdEnumerations"],
      change:
        "The key `code` becomes `record_id`; `enumeration` and `value` give way to `enum_domain`, `enum_code`, `enum_label`, `description`, `sort_order`, `color_code`, `target_entity`, `is_default` and the shared sheet columns.",
      reason: mirrorReason("xpms.std_enumeration", "Enumerations"),
      apply: editShape({
        rename: { code: "record_id" },
        remove: ["enumeration", "value"],
        add: {
          enum_domain: cell("Enumeration the value belongs to.", "Incident Severity", 200),
          enum_code: cell("Code of the value.", "SEV_L3_MODERATE", 200),
          enum_label: cell("Label of the value.", "Level 3 - Moderate", 500),
          description: cell("What the value means.", "Non-life-threatening medical case."),
          sort_order: numberCell("Order within the enumeration.", 3),
          color_code: cell("Display color as the sheet stores it.", "Amber", 50),
          target_entity: cell("Record the enumeration applies to.", "Incident CAD Log", 200),
          is_default: boolCell("Whether the value is the default.", false),
          ...sheetColumns,
        },
      }),
    },
    {
      id: "canon-std-labor-rate-card-resolved",
      since: MIRROR,
      resources: ["canonStdLaborRateCards"],
      change:
        "The resource reads `xpms.rate_card_resolved`: the key `code` becomes `rate_card_id`; `rate_minor`, `currency` and `unit` give way to the canon combination (`worker_classification`, `pay_basis`, `arrangement`), the standard, grade and per diem rates in `currency_code`, the overtime rule with its multipliers, and the role's job title, department and expense GL account.",
      reason:
        "There is no std_labor_rate_card table: the Labor Rate Cards sheet is xpms.rate_card (0101), one canon rate per role and permitted classification, pay basis and arrangement, and xpms.rate_card_resolved (0107) adds the job title, department, overtime multipliers and expense account a reader needs. Rates are integer minor units, NULL where the sheet leaves them unpriced. Decided in ADR 0032.",
      apply: all(
        setTable("xpms.rate_card_resolved"),
        editShape({
          rename: { code: "rate_card_id" },
          remove: ["rate_minor", "currency", "unit"],
          add: {
            rate_card_id: {
              schema: fields.code("Canon rate card identifier.", "LRC-001"),
            },
            job_title: cell("Job title of the role.", "Head Rigger", 300),
            class_code: { schema: canonCodes.DeptCode },
            department: { schema: fields.text("Department of the role.", "Production", 200) },
            worker_classification: {
              schema: fields.text("Worker classification label.", "Employee", 200),
            },
            pay_basis: { schema: fields.text("Pay basis.", "Hourly", 200) },
            arrangement: { schema: fields.text("Arrangement.", "Per Engagement", 200) },
            standard_rate_minor: { schema: fields.money("Standard rate.", 4500) },
            min_grade_rate_minor: { schema: fields.money("Lowest grade rate.", 3800) },
            max_grade_rate_minor: { schema: fields.money("Highest grade rate.", 5200) },
            per_diem_rate_minor: { schema: fields.money("Per diem rate.", 6500) },
            currency_code: { schema: fields.currency("ISO 4217 currency of the rates.") },
            overtime_rule_id: { schema: fields.code("Canon overtime rule.", "OTR-001") },
            ot_multiplier: {
              schema: z.number().meta({ description: "Overtime multiplier.", example: 1.5 }),
            },
            dt_multiplier: {
              schema: z.number().meta({ description: "Double time multiplier.", example: 2 }),
            },
            gl_account: cell("Expense GL account of the role's department.", "5400", 50),
            gl_account_name: cell("Name of that GL account.", "Production Labor", 300),
          },
        }),
      ),
    },
    {
      id: "canon-std-radio-channel-columns",
      since: MIRROR,
      resources: ["canonStdRadioChannels"],
      change:
        "The key `code` becomes `record_id`; `channel` becomes a nullable number, `name` gives way to `assignment`, and adds `zone` and the shared sheet columns.",
      reason: mirrorReason("xpms.std_radio_channel", "Radio Channels"),
      apply: editShape({
        rename: { code: "record_id" },
        remove: ["name"],
        add: {
          channel: numberCell("Radio channel number.", 1),
          zone: numberCell("Radio zone.", 1),
          assignment: cell("Who the channel is assigned to.", "Emergency", 300),
          ...sheetColumns,
        },
      }),
    },
    {
      id: "canon-std-roles-library",
      since: MIRROR,
      resources: ["canonStdRoles"],
      change:
        "The resource reads the Roles Library `xpms.role`, keyed by `role_code` (`code` and `description` are removed): adds `class_code`, `job_title`, `discipline`, `rank`, `job_summary`, `key_responsibilities`, `qualifications`, `physical_requirements`, `required_certifications`, `default_clearance_tier`, `default_radio_channel` and `notes`.",
      reason:
        "There is no std_role table: the Playbook Roles Library sheet is xpms.role (0101), which owns role codes and job titles (decision D12) and keys each role by its code. Decided in ADR 0032.",
      apply: all(
        setTable("xpms.role"),
        editShape({
          remove: ["code", "description"],
          key: "role_code",
          add: {
            class_code: { schema: canonCodes.DeptCode },
            job_title: {
              schema: fields.text("Job title; the one home of the title.", "Head Rigger", 300),
            },
            discipline: { schema: fields.text("Discipline.", "Rigging", 200) },
            rank: { schema: fields.text("Rank.", "Lead", 200) },
            job_summary: cell("Job summary.", "Leads the rigging crew."),
            key_responsibilities: cell("Key responsibilities.", "Plans and signs off every point."),
            qualifications: cell("Qualifications.", "ETCP Certified Rigger."),
            physical_requirements: cell("Physical requirements.", "Works at height."),
            required_certifications: cell("Required certifications.", "ETCP"),
            default_clearance_tier: cell("Default clearance tier.", "Tier 2", 200),
            default_radio_channel: cell("Default radio channel.", "RCH-004", 200),
            notes: cell("Notes in the sheet.", "Union call."),
          },
        }),
      ),
    },
    {
      id: "canon-std-sop-columns",
      since: MIRROR,
      resources: ["canonStdSops"],
      change:
        "The key `code` becomes `sop_id`; `title` becomes nullable and `body` gives way to the sheet's columns: `operational_domain`, `revision`, `accountable_role_code`, `required_ppe_compliance_tag`, `prerequisites_and_hazards`, `procedure_step_1` to `procedure_step_4`, `reference_doc_id` and the shared sheet columns.",
      reason: mirrorReason("xpms.std_sop", "SOPs"),
      apply: editShape({
        rename: { code: "sop_id" },
        remove: ["body"],
        nullable: ["title"],
        add: {
          operational_domain: cell("Operational domain.", "Structural & Rigging Safety", 300),
          revision: cell("Revision.", "v2.0", 100),
          accountable_role_code: cell("Accountable role code.", "5000.51.02", 100),
          required_ppe_compliance_tag: cell("Required PPE and compliance tags.", "TAG-002 OSHA"),
          prerequisites_and_hazards: cell("Prerequisites and hazards.", "Verify the drop zone."),
          procedure_step_1: cell("Procedure step 1.", "Inspect every hoist."),
          procedure_step_2: cell("Procedure step 2.", "Lift to trim."),
          procedure_step_3: cell("Procedure step 3.", "Load test."),
          procedure_step_4: cell("Procedure step 4.", "Sign off."),
          reference_doc_id: cell("Reference document.", "DOC-004", 200),
          ...sheetColumns,
        },
      }),
    },
    {
      id: "canon-std-vendor-class-columns",
      since: MIRROR,
      resources: ["canonStdVendorClasses"],
      change:
        "The key `code` becomes `record_id`; `name` becomes the nullable `class`, `counterparty_type` is removed, and adds `description`, `clearance_tier` and the shared sheet columns.",
      reason: mirrorReason("xpms.std_vendor_class", "Vendor Classes"),
      apply: editShape({
        rename: { code: "record_id" },
        remove: ["name", "counterparty_type"],
        add: {
          class: cell("Vendor class.", "Staging Vendor", 300),
          description: cell("What the class covers.", "Stages, decks and risers."),
          clearance_tier: cell("Clearance tier.", "Tier 2", 200),
          ...sheetColumns,
        },
      }),
    },
    {
      id: "canon-std-vendor-entitlement-columns",
      since: MIRROR,
      resources: ["canonStdVendorEntitlements"],
      change:
        "The key `code` becomes `record_id`; `name` and `description` give way to `vendor_class`, `module`, `permitted`, `status` and `notes`.",
      reason: mirrorReason("xpms.std_vendor_entitlement", "Vendor Entitlements"),
      apply: editShape({
        rename: { code: "record_id" },
        remove: ["name", "description"],
        add: {
          vendor_class: cell("Vendor class the entitlement is for.", "VCL-001", 100),
          module: cell("Module the class may use.", "Advance", 200),
          permitted: boolCell("Whether the class may use the module.", true),
          status: sheetColumns.status,
          notes: sheetColumns.notes,
        },
      }),
    },
    {
      id: "canon-std-verbiage-columns",
      since: MIRROR,
      resources: ["canonStdVerbiage"],
      change:
        "The key `code` becomes `record_id`; `term` becomes the nullable `verbiage`, `usage` gives way to `title`, `body` and `description`, and adds the shared sheet columns.",
      reason: mirrorReason("xpms.std_verbiage", "Verbiage"),
      apply: editShape({
        rename: { code: "record_id", term: "verbiage" },
        remove: ["usage"],
        nullable: ["verbiage"],
        add: {
          title: cell("Title.", "Load-In Announcement", 500),
          body: cell("Text.", "All crew to the loading dock."),
          description: cell("When the text is used.", "Read at the start of load-in."),
          ...sheetColumns,
        },
      }),
    },
    {
      id: "canon-production-template-private",
      since: MIRROR,
      resources: ["canonProductionTemplates"],
      change: "Removes every canonProductionTemplates operation.",
      reason:
        "xpms.production_template (0105) holds real-world rows and stays private: 0199 grants tenants no read on it until the owner approves publishing it (ADR 0014 owner decision 8, Section 2.1). An operation that every caller is refused leaves v1; it returns additively once the template is published. Decided in ADR 0032.",
      apply: removeVerbs("list", "get"),
    },
    {
      id: "canon-supersession-by-domain",
      since: MIRROR,
      resources: ["canonSupersessions"],
      change:
        "`superseded_code` becomes `code` and `superseded_by` becomes `successor_code`; `ratification_id` is removed and adds `domain`, `label` and `reason`. Lists order by domain and code, and `canonSupersessions.get` is removed: a code is unique only within its domain.",
      reason:
        "xpms.supersession (0101) keys a supersession by its code domain and code, records the successor, the label the old code carried and why it was superseded, and names no ratification. One code can be superseded in two domains, so no single path key identifies a row; filter the list by domain and code instead. Decided in ADR 0032.",
      apply: all(
        editShape({
          rename: { superseded_code: "code", superseded_by: "successor_code" },
          remove: ["ratification_id"],
          add: {
            domain: { schema: fields.code("Code domain, such as phase.", "phase") },
            label: { schema: fields.text("Label the superseded code carried.", "Discovery", 300) },
            reason: {
              schema: fields.text("Why the code was superseded.", "Renamed in 4.0.", 2000),
            },
          },
        }),
        removeVerbs("get"),
        setOrder({ by: ["domain", "code"], numeric: false }),
      ),
    },
    {
      id: "canon-ratification-by-subject",
      since: MIRROR,
      resources: ["canonRatifications"],
      change:
        "A ratification is keyed by its `subject` (path parameter included); `ratification_id` is removed and adds `note`.",
      reason:
        "xpms.ratification (0101) keys each ratification by what it ratifies, such as the 4.0 grammar, and has no identifier column; it records the named ratifier, the time and a note. Decided in ADR 0032.",
      apply: editShape({
        remove: ["ratification_id"],
        key: "subject",
        add: { note: cell("Ratification note.", "Ratified at the canon review.", 4000) },
      }),
    },
    {
      id: "canon-intake-not-tenant-proposals",
      since: MIRROR,
      resources: ["canonIntake"],
      change:
        "Removes every canonIntake operation. An org proposes canon through `canonExtensions.propose`.",
      reason:
        "xpms.intake (0101) is the canon pipeline's staging of Playbook and Bible cells awaiting an owner decision (ADR 0014 owner decision 1), keyed by source file, sheet, row and column. It holds no tenant proposals, and the shared CanonIntake shape describes the proposals that canonExtensions.propose records in app.canon_extension_proposals (0490). Decided in ADR 0032.",
      apply: removeVerbs("list", "get", "create"),
    },
    {
      id: "canon-urn-resolution-superseded",
      since: MIRROR,
      resources: ["canonUrns"],
      change:
        "The resolution adds `resolved_key`, the live key after following supersessions, and `is_superseded`.",
      reason:
        "xpms.urn_resolve (0103) follows the supersession graph, so `urn:xpms:phase:DIS` resolves to SCP; it returns the asked key, the resolved key and whether a supersession was followed, which the frozen shape could not carry.",
      apply: editShape({
        add: {
          resolved_key: {
            schema: fields.code("Key of the live row after following supersessions.", "SCP"),
          },
          is_superseded: { schema: fields.bool("Whether the asked key was superseded.", false) },
        },
      }),
    },
    ...canonFieldExposure,
  ],
});
