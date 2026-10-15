/**
 * A04P contract tests for the Canon handlers: every handled canon list and read, and the element
 * and GTIN resolvers. Requests run through `contractApp` against the in-memory client seeded with
 * one documented sample row per canon table; every response is checked against openapi/v1.json
 * with `expectContract`. Generated rows come from the contract's examples (test/support/samples.ts).
 */
import { describe, expect, it } from "vitest";
import { handlers } from "../src/handlers/canon.ts";
import { contractApp, expectContract } from "./support/contract.ts";
import { memoryDb, requests, success } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";
import { sample } from "./support/samples.ts";

function sampleKey(component: string, key: string): unknown {
  return sample(component)[key];
}

const element = sample("CanonElement");

function world() {
  const db = memoryDb(
    {
      "xpms.dim_discipline": [sample("CanonDiscipline")],
      "xpms.dim_category": [sample("CanonCategory")],
      "xpms.dim_act": [sample("CanonAct")],
      "xpms.dim_phase": [sample("CanonPhase")],
      "xpms.dim_gate_criterion": [sample("CanonGateCriterion")],
      "xpms.dim_tier": [sample("CanonTier")],
      "xpms.dim_team": [sample("CanonTeam")],
      "xpms.dim_tag": [sample("CanonTag")],
      "xpms.dim_touchpoint": [sample("CanonTouchpoint")],
      "xpms.jurisdiction": [sample("CanonJurisdiction")],
      "xpms.dim_region": [sample("CanonRegion")],
      "xpms.dim_region_multiplier": [sample("CanonRegionMultiplier")],
      "xpms.dim_escalation_index": [sample("CanonEscalationIndex")],
      "xpms.dim_staleness_policy": [sample("CanonStalenessPolicy")],
      "xpms.dim_permit_rule": [sample("CanonPermitRule")],
      "xpms.dim_metric": [sample("CanonMetric")],
      "xpms.dim_identifier_class": [sample("CanonIdentifierClass")],
      "xpms.dim_grain": [sample("CanonGrain")],
      "xpms.dim_provenance": [sample("CanonProvenance")],
      "xpms.dim_facet": [sample("CanonFacet")],
      "xpms.dim_assertion_rank": [sample("CanonAssertionRank")],
      "xpms.dim_record_kind": [sample("CanonRecordKind")],
      "xpms.dim_record_subtype": [sample("CanonRecordSubtype")],
      "xpms.dim_record_state": [sample("CanonRecordState")],
      "xpms.dim_role": [sample("CanonRole")],
      "xpms.dim_counterparty_type": [sample("CanonCounterpartyType")],
      "xpms.dim_gl_account": [sample("CanonGlAccount")],
      "xpms.dim_cost_center_template": [sample("CanonCostCenterTemplate")],
      "xpms.dim_category_gl": [sample("CanonCategoryGl")],
      "xpms.dim_unit_alias": [sample("CanonUnitAlias")],
      "xpms.dim_unit_dimension": [sample("CanonUnitDimension")],
      "xpms.dim_urn_namespace": [sample("CanonUrnNamespace")],
      "xpms.dim_locale": [sample("CanonLocale")],
      "xpms.elements": [sample("CanonElement")],
      "xpms.element_price_bands": [sample("CanonElementPriceBand")],
      "xpms.element_gtins": [sample("CanonElementGtin")],
      "xpms.bridge_element_phase": [sample("CanonElementPhase")],
      "xpms.bridge_element_tag": [sample("CanonElementTag")],
      "xpms.bridge_element_permit": [sample("CanonElementPermit")],
      "xpms.bridge_element_metric": [sample("CanonElementMetric")],
      "xpms.bridge_touchpoint_discipline": [sample("CanonTouchpointDiscipline")],
      "xpms.bridge_discipline_team": [sample("CanonDisciplineTeam")],
      "xpms.emergency_code": [sample("StdEmergencyCode")],
      "xpms.version": [sample("CanonVersion")],
      "xpms.v_coordinate_matrix": [sample("CoordinateMatrixCell")],
      "xpms.v_phase_coverage": [sample("PhaseCoverage")],
      "xpms.v_element_economics": [sample("ElementEconomics")],
      "xpms.v_crosswalk_coverage": [sample("CrosswalkCoverage")],
    },
    {
      "xpms.resolve_element": (args) =>
        args["query"] === element["item"]
          ? [
              {
                element_id: element["element_id"],
                item: element["item"],
                urid: element["urid"],
                match: "item",
              },
            ]
          : [],
      "xpms.resolve_gtin": (args) =>
        args["code"] === "00012345678905" ? element["element_id"] : null,
    },
  );
  const app = contractApp({ handlers: [handlers], db });
  return { db, http: requests(app) };
}

const { http } = world();

describe("canon lists and reads", () => {
  it("serves canonDisciplines", async () => {
    const listed = await http.get("/canon/disciplines");
    const page = (await expectContract(await success(listed), "canonDisciplines.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["disc_code"]));
    const read = await http.get(`/canon/disciplines/${key}`);
    await expectContract(await success(read), "canonDisciplines.get");
    const missing = await http.get(
      "/canon/disciplines/" +
        encodeURIComponent(String(sampleKey("CanonDiscipline", "disc_code"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonCategories", async () => {
    const listed = await http.get("/canon/categories");
    const page = (await expectContract(await success(listed), "canonCategories.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["cat_urid"]));
    const read = await http.get(`/canon/categories/${key}`);
    await expectContract(await success(read), "canonCategories.get");
    const missing = await http.get(
      "/canon/categories/" +
        encodeURIComponent(String(sampleKey("CanonCategory", "cat_urid"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonActs", async () => {
    const listed = await http.get("/canon/acts");
    const page = (await expectContract(await success(listed), "canonActs.list")) as { data: Row[] };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["act_code"]));
    const read = await http.get(`/canon/acts/${key}`);
    await expectContract(await success(read), "canonActs.get");
    const missing = await http.get(
      "/canon/acts/" + encodeURIComponent(String(sampleKey("CanonAct", "act_code"))) + "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonPhases", async () => {
    const listed = await http.get("/canon/phases");
    const page = (await expectContract(await success(listed), "canonPhases.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["phase_code"]));
    const read = await http.get(`/canon/phases/${key}`);
    await expectContract(await success(read), "canonPhases.get");
    const missing = await http.get(
      "/canon/phases/" +
        encodeURIComponent(String(sampleKey("CanonPhase", "phase_code"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonGateCriteria", async () => {
    const listed = await http.get("/canon/gate-criteria");
    const page = (await expectContract(await success(listed), "canonGateCriteria.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["criterion_id"]));
    const read = await http.get(`/canon/gate-criteria/${key}`);
    await expectContract(await success(read), "canonGateCriteria.get");
    const missing = await http.get(
      "/canon/gate-criteria/" +
        encodeURIComponent(String(sampleKey("CanonGateCriterion", "criterion_id"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonTiers", async () => {
    const listed = await http.get("/canon/tiers");
    const page = (await expectContract(await success(listed), "canonTiers.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["tier_code"]));
    const read = await http.get(`/canon/tiers/${key}`);
    await expectContract(await success(read), "canonTiers.get");
    const missing = await http.get(
      "/canon/tiers/" + encodeURIComponent(String(sampleKey("CanonTier", "tier_code"))) + "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonTeams", async () => {
    const listed = await http.get("/canon/teams");
    const page = (await expectContract(await success(listed), "canonTeams.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["team_id"]));
    const read = await http.get(`/canon/teams/${key}`);
    await expectContract(await success(read), "canonTeams.get");
    const missing = await http.get(
      "/canon/teams/" + encodeURIComponent(String(sampleKey("CanonTeam", "team_id"))) + "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonTags", async () => {
    const listed = await http.get("/canon/tags");
    const page = (await expectContract(await success(listed), "canonTags.list")) as { data: Row[] };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["tag_id"]));
    const read = await http.get(`/canon/tags/${key}`);
    await expectContract(await success(read), "canonTags.get");
    const missing = await http.get(
      "/canon/tags/" + encodeURIComponent(String(sampleKey("CanonTag", "tag_id"))) + "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonTouchpoints", async () => {
    const listed = await http.get("/canon/touchpoints");
    const page = (await expectContract(await success(listed), "canonTouchpoints.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["touchpoint_id"]));
    const read = await http.get(`/canon/touchpoints/${key}`);
    await expectContract(await success(read), "canonTouchpoints.get");
    const missing = await http.get(
      "/canon/touchpoints/" +
        encodeURIComponent(String(sampleKey("CanonTouchpoint", "touchpoint_id"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonJurisdictions", async () => {
    const listed = await http.get("/canon/jurisdictions");
    const page = (await expectContract(await success(listed), "canonJurisdictions.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["jurisdiction_id"]));
    const read = await http.get(`/canon/jurisdictions/${key}`);
    await expectContract(await success(read), "canonJurisdictions.get");
    const missing = await http.get(
      "/canon/jurisdictions/" +
        encodeURIComponent(String(sampleKey("CanonJurisdiction", "jurisdiction_id"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonRegions", async () => {
    const listed = await http.get("/canon/regions");
    const page = (await expectContract(await success(listed), "canonRegions.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["region_code"]));
    const read = await http.get(`/canon/regions/${key}`);
    await expectContract(await success(read), "canonRegions.get");
    const missing = await http.get(
      "/canon/regions/" +
        encodeURIComponent(String(sampleKey("CanonRegion", "region_code"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonRegionMultipliers", async () => {
    const listed = await http.get("/canon/region-multipliers");
    const page = (await expectContract(await success(listed), "canonRegionMultipliers.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["region_code"]));
    const read = await http.get(`/canon/region-multipliers/${key}`);
    await expectContract(await success(read), "canonRegionMultipliers.get");
    const missing = await http.get(
      "/canon/region-multipliers/" +
        encodeURIComponent(String(sampleKey("CanonRegionMultiplier", "region_code"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonEscalationIndices", async () => {
    const listed = await http.get("/canon/escalation-indices");
    const page = (await expectContract(await success(listed), "canonEscalationIndices.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["index_id"]));
    const read = await http.get(`/canon/escalation-indices/${key}`);
    await expectContract(await success(read), "canonEscalationIndices.get");
    const missing = await http.get(
      "/canon/escalation-indices/" +
        encodeURIComponent(String(sampleKey("CanonEscalationIndex", "index_id"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonStalenessPolicies", async () => {
    const listed = await http.get("/canon/staleness-policies");
    const page = (await expectContract(await success(listed), "canonStalenessPolicies.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["age_months_gte"]));
    const read = await http.get(`/canon/staleness-policies/${key}`);
    await expectContract(await success(read), "canonStalenessPolicies.get");
    const missing = await http.get(
      "/canon/staleness-policies/" +
        encodeURIComponent(String(sampleKey("CanonStalenessPolicy", "age_months_gte"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonPermitRules", async () => {
    const listed = await http.get("/canon/permit-rules");
    const page = (await expectContract(await success(listed), "canonPermitRules.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["rule"]));
    const read = await http.get(`/canon/permit-rules/${key}`);
    await expectContract(await success(read), "canonPermitRules.get");
    const missing = await http.get(
      "/canon/permit-rules/" +
        encodeURIComponent(String(sampleKey("CanonPermitRule", "rule"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonMetrics", async () => {
    const listed = await http.get("/canon/metrics");
    const page = (await expectContract(await success(listed), "canonMetrics.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["item"]));
    const read = await http.get(`/canon/metrics/${key}`);
    await expectContract(await success(read), "canonMetrics.get");
    const missing = await http.get(
      "/canon/metrics/" + encodeURIComponent(String(sampleKey("CanonMetric", "item"))) + "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonIdentifierClasses", async () => {
    const listed = await http.get("/canon/identifier-classes");
    const page = (await expectContract(await success(listed), "canonIdentifierClasses.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["class"]));
    const read = await http.get(`/canon/identifier-classes/${key}`);
    await expectContract(await success(read), "canonIdentifierClasses.get");
    const missing = await http.get(
      "/canon/identifier-classes/" +
        encodeURIComponent(String(sampleKey("CanonIdentifierClass", "class"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonGrains", async () => {
    const listed = await http.get("/canon/grains");
    const page = (await expectContract(await success(listed), "canonGrains.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["grain"]));
    const read = await http.get(`/canon/grains/${key}`);
    await expectContract(await success(read), "canonGrains.get");
    const missing = await http.get(
      "/canon/grains/" + encodeURIComponent(String(sampleKey("CanonGrain", "grain"))) + "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonProvenances", async () => {
    const listed = await http.get("/canon/provenances");
    const page = (await expectContract(await success(listed), "canonProvenances.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["provenance"]));
    const read = await http.get(`/canon/provenances/${key}`);
    await expectContract(await success(read), "canonProvenances.get");
    const missing = await http.get(
      "/canon/provenances/" +
        encodeURIComponent(String(sampleKey("CanonProvenance", "provenance"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonFacets", async () => {
    const listed = await http.get("/canon/facets");
    const page = (await expectContract(await success(listed), "canonFacets.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["facet"]));
    const read = await http.get(`/canon/facets/${key}`);
    await expectContract(await success(read), "canonFacets.get");
    const missing = await http.get(
      "/canon/facets/" + encodeURIComponent(String(sampleKey("CanonFacet", "facet"))) + "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonAssertionRanks", async () => {
    const listed = await http.get("/canon/assertion-ranks");
    const page = (await expectContract(await success(listed), "canonAssertionRanks.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["rank"]));
    const read = await http.get(`/canon/assertion-ranks/${key}`);
    await expectContract(await success(read), "canonAssertionRanks.get");
    const missing = await http.get(
      "/canon/assertion-ranks/" +
        encodeURIComponent(String(sampleKey("CanonAssertionRank", "rank"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonRecordKinds", async () => {
    const listed = await http.get("/canon/record-kinds");
    const page = (await expectContract(await success(listed), "canonRecordKinds.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["record_kind"]));
    const read = await http.get(`/canon/record-kinds/${key}`);
    await expectContract(await success(read), "canonRecordKinds.get");
    const missing = await http.get(
      "/canon/record-kinds/" +
        encodeURIComponent(String(sampleKey("CanonRecordKind", "record_kind"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonRecordSubtypes", async () => {
    const listed = await http.get("/canon/record-subtypes");
    const page = (await expectContract(await success(listed), "canonRecordSubtypes.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["record_subtype"]));
    const read = await http.get(`/canon/record-subtypes/${key}`);
    await expectContract(await success(read), "canonRecordSubtypes.get");
    const missing = await http.get(
      "/canon/record-subtypes/" +
        encodeURIComponent(String(sampleKey("CanonRecordSubtype", "record_subtype"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonRecordStates", async () => {
    const listed = await http.get("/canon/record-states");
    const page = (await expectContract(await success(listed), "canonRecordStates.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["record_state"]));
    const read = await http.get(`/canon/record-states/${key}`);
    await expectContract(await success(read), "canonRecordStates.get");
    const missing = await http.get(
      "/canon/record-states/" +
        encodeURIComponent(String(sampleKey("CanonRecordState", "record_state"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonRoles", async () => {
    const listed = await http.get("/canon/roles");
    const page = (await expectContract(await success(listed), "canonRoles.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["role_code"]));
    const read = await http.get(`/canon/roles/${key}`);
    await expectContract(await success(read), "canonRoles.get");
    const missing = await http.get(
      "/canon/roles/" + encodeURIComponent(String(sampleKey("CanonRole", "role_code"))) + "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonCounterpartyTypes", async () => {
    const listed = await http.get("/canon/counterparty-types");
    const page = (await expectContract(await success(listed), "canonCounterpartyTypes.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["counterparty_type"]));
    const read = await http.get(`/canon/counterparty-types/${key}`);
    await expectContract(await success(read), "canonCounterpartyTypes.get");
    const missing = await http.get(
      "/canon/counterparty-types/" +
        encodeURIComponent(String(sampleKey("CanonCounterpartyType", "counterparty_type"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonGlAccounts", async () => {
    const listed = await http.get("/canon/gl-accounts");
    const page = (await expectContract(await success(listed), "canonGlAccounts.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["account_code"]));
    const read = await http.get(`/canon/gl-accounts/${key}`);
    await expectContract(await success(read), "canonGlAccounts.get");
    const missing = await http.get(
      "/canon/gl-accounts/" +
        encodeURIComponent(String(sampleKey("CanonGlAccount", "account_code"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonCostCenterTemplates", async () => {
    const listed = await http.get("/canon/cost-center-templates");
    const page = (await expectContract(await success(listed), "canonCostCenterTemplates.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["cost_center_id"]));
    const read = await http.get(`/canon/cost-center-templates/${key}`);
    await expectContract(await success(read), "canonCostCenterTemplates.get");
    const missing = await http.get(
      "/canon/cost-center-templates/" +
        encodeURIComponent(String(sampleKey("CanonCostCenterTemplate", "cost_center_id"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonCategoryGl", async () => {
    const listed = await http.get("/canon/category-gl");
    const page = (await expectContract(await success(listed), "canonCategoryGl.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["cat_urid"]));
    const read = await http.get(`/canon/category-gl/${key}`);
    await expectContract(await success(read), "canonCategoryGl.get");
    const missing = await http.get(
      "/canon/category-gl/" +
        encodeURIComponent(String(sampleKey("CanonCategoryGl", "cat_urid"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonUnitAliases", async () => {
    const listed = await http.get("/canon/unit-aliases");
    const page = (await expectContract(await success(listed), "canonUnitAliases.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["alias"]));
    const read = await http.get(`/canon/unit-aliases/${key}`);
    await expectContract(await success(read), "canonUnitAliases.get");
    const missing = await http.get(
      "/canon/unit-aliases/" +
        encodeURIComponent(String(sampleKey("CanonUnitAlias", "alias"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonUnitDimensions", async () => {
    const listed = await http.get("/canon/unit-dimensions");
    const page = (await expectContract(await success(listed), "canonUnitDimensions.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["dimension_code"]));
    const read = await http.get(`/canon/unit-dimensions/${key}`);
    await expectContract(await success(read), "canonUnitDimensions.get");
    const missing = await http.get(
      "/canon/unit-dimensions/" +
        encodeURIComponent(String(sampleKey("CanonUnitDimension", "dimension_code"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonUrnNamespaces", async () => {
    const listed = await http.get("/canon/urn-namespaces");
    const page = (await expectContract(await success(listed), "canonUrnNamespaces.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["kind"]));
    const read = await http.get(`/canon/urn-namespaces/${key}`);
    await expectContract(await success(read), "canonUrnNamespaces.get");
    const missing = await http.get(
      "/canon/urn-namespaces/" +
        encodeURIComponent(String(sampleKey("CanonUrnNamespace", "kind"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonLocales", async () => {
    const listed = await http.get("/canon/locales");
    const page = (await expectContract(await success(listed), "canonLocales.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["locale_code"]));
    const read = await http.get(`/canon/locales/${key}`);
    await expectContract(await success(read), "canonLocales.get");
    const missing = await http.get(
      "/canon/locales/" +
        encodeURIComponent(String(sampleKey("CanonLocale", "locale_code"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonElements", async () => {
    const listed = await http.get("/canon/elements");
    const page = (await expectContract(await success(listed), "canonElements.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["element_id"]));
    const read = await http.get(`/canon/elements/${key}`);
    await expectContract(await success(read), "canonElements.get");
    const missing = await http.get(
      "/canon/elements/" +
        encodeURIComponent(String(sampleKey("CanonElement", "element_id"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonElementPriceBands", async () => {
    const listed = await http.get("/canon/element-price-bands");
    const page = (await expectContract(await success(listed), "canonElementPriceBands.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
  });
  it("serves canonElementGtins", async () => {
    const listed = await http.get("/canon/element-gtins");
    const page = (await expectContract(await success(listed), "canonElementGtins.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["gtin"]));
    const read = await http.get(`/canon/element-gtins/${key}`);
    await expectContract(await success(read), "canonElementGtins.get");
    const missing = await http.get(
      "/canon/element-gtins/" +
        encodeURIComponent(String(sampleKey("CanonElementGtin", "gtin"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonElementPhases", async () => {
    const listed = await http.get("/canon/element-phases");
    const page = (await expectContract(await success(listed), "canonElementPhases.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
  });
  it("serves canonElementTags", async () => {
    const listed = await http.get("/canon/element-tags");
    const page = (await expectContract(await success(listed), "canonElementTags.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
  });
  it("serves canonElementPermits", async () => {
    const listed = await http.get("/canon/element-permits");
    const page = (await expectContract(await success(listed), "canonElementPermits.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
  });
  it("serves canonElementMetrics", async () => {
    const listed = await http.get("/canon/element-metrics");
    const page = (await expectContract(await success(listed), "canonElementMetrics.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
  });
  it("serves canonTouchpointDisciplines", async () => {
    const listed = await http.get("/canon/touchpoint-disciplines");
    const page = (await expectContract(
      await success(listed),
      "canonTouchpointDisciplines.list",
    )) as { data: Row[] };
    expect(page.data).toHaveLength(1);
  });
  it("serves canonDisciplineTeams", async () => {
    const listed = await http.get("/canon/discipline-teams");
    const page = (await expectContract(await success(listed), "canonDisciplineTeams.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
  });
  it("serves canonStdEmergencyCodes", async () => {
    const listed = await http.get("/canon/std/emergency-codes");
    const page = (await expectContract(await success(listed), "canonStdEmergencyCodes.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["code"]));
    const read = await http.get(`/canon/std/emergency-codes/${key}`);
    await expectContract(await success(read), "canonStdEmergencyCodes.get");
    const missing = await http.get(
      "/canon/std/emergency-codes/" +
        encodeURIComponent(String(sampleKey("StdEmergencyCode", "code"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonVersions", async () => {
    const listed = await http.get("/canon/versions");
    const page = (await expectContract(await success(listed), "canonVersions.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
    const key = encodeURIComponent(String(page.data[0]?.["generation"]));
    const read = await http.get(`/canon/versions/${key}`);
    await expectContract(await success(read), "canonVersions.get");
    const missing = await http.get(
      "/canon/versions/" +
        encodeURIComponent(String(sampleKey("CanonVersion", "generation"))) +
        "-none",
    );
    expect([404, 422]).toContain(missing.status);
  });
  it("serves canonCoordinateMatrix", async () => {
    const listed = await http.get("/canon/coordinate-matrix");
    const page = (await expectContract(await success(listed), "canonCoordinateMatrix.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
  });
  it("serves canonPhaseCoverage", async () => {
    const listed = await http.get("/canon/phase-coverage");
    const page = (await expectContract(await success(listed), "canonPhaseCoverage.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
  });
  it("serves canonElementEconomics", async () => {
    const listed = await http.get("/canon/element-economics");
    const page = (await expectContract(await success(listed), "canonElementEconomics.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
  });
  it("serves canonCrosswalkCoverage", async () => {
    const listed = await http.get("/canon/crosswalk-coverage");
    const page = (await expectContract(await success(listed), "canonCrosswalkCoverage.list")) as {
      data: Row[];
    };
    expect(page.data).toHaveLength(1);
  });
});

describe("canon resolvers", () => {
  it("resolves an element by name and answers NO_ANSWER when nothing matches", async () => {
    const found = await http.get(
      `/canon/elements/resolve?query=${encodeURIComponent(String(element["item"]))}`,
    );
    const hit = (await expectContract(await success(found), "canonElements.resolve")) as Row;
    expect(hit["match"]).toBe("item");
    const none = await http.get("/canon/elements/resolve?query=nothing%20like%20it");
    expect(none.status).toBe(422);
    expect(((await none.json()) as Row)["refusal"]).toBe("NO_ANSWER");
  });

  it("resolves a GTIN and answers NO_ANSWER for an unknown one", async () => {
    const found = await http.get("/canon/element-gtins/resolve?gtin=00012345678905");
    const hit = (await expectContract(await success(found), "canonElementGtins.resolve")) as Row;
    expect(hit).toMatchObject({ element_id: element["element_id"], match: "gtin" });
    const none = await http.get("/canon/element-gtins/resolve?gtin=00099999999999");
    expect(none.status).toBe(422);
  });
});
