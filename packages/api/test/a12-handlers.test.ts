/**
 * Contract tests for A12's Assets handlers (Section 18, gate 5). Requests run through `contractApp`
 * against the in-memory client; every response is checked against openapi/v1.json with
 * `expectContract`. Refusals (422), hidden rows (404), stale If-Match (412), the lifecycle, the scan
 * resolution (NO_ANSWER) and the idempotent scan event (duplicate) are checked too.
 */
import { describe, expect, it } from "vitest";
import { handlers as assets } from "../src/handlers/assets.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { MemoryDb, Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(12000 + n).padStart(12, "0")}`;
const CLASS = id(1);
const EMPTY_CLASS = id(2);
const UNIT = id(3);
const LOT = id(4);
const IDENT = id(5);
const CUSTODY = id(6);
const MAINT = id(7);
const DAMAGE = id(8);
const VENUE = id(9);
const MEMBER = id(10);
const PROJECT = id(11);
const EVENT = id(12);
const STALE = 'W/"MjAyMC0wMS0wMQ"';

function world() {
  const db: MemoryDb = memoryDb(
    {
      asset_classes: [
        tenantRow(CLASS, ORG, { name: "Spot Fixture", element_id: "5000.02.02-XPMS-003" }),
        tenantRow(EMPTY_CLASS, ORG, { name: "Laser Projector", element_id: "5000.03.02-XPMS-005" }),
      ],
      asset_units: [
        tenantRow(UNIT, ORG, {
          asset_class_id: CLASS,
          asset_tag: "MH-001",
          asset_state: "Available",
          condition_enum_id: "ENM-017",
          home_venue_id: VENUE,
        }),
      ],
      asset_lots: [tenantRow(LOT, ORG, { asset_class_id: CLASS, venue_id: VENUE, quantity: 40 })],
      asset_lot_balances: [{ asset_lot_id: LOT, org_id: ORG, opening_quantity: 40, on_hand: 34 }],
      asset_identifiers: [
        tenantRow(IDENT, ORG, {
          asset_unit_id: UNIT,
          identifier_class: "identifier",
          scheme: "serial",
          value: "SPX-48810",
        }),
      ],
      asset_custody: [
        tenantRow(CUSTODY, ORG, {
          asset_unit_id: UNIT,
          custodian_membership_id: MEMBER,
          custodian_engagement_id: null,
          venue_id: null,
          project_id: PROJECT,
          note: "Issued for load-in.",
        }),
      ],
      asset_maintenance: [
        tenantRow(MAINT, ORG, {
          asset_unit_id: UNIT,
          performed_on: "2026-10-01",
          description: "Lamp replaced.",
          cost_minor: null,
          currency_code: null,
        }),
      ],
      asset_damage: [
        tenantRow(DAMAGE, ORG, {
          asset_unit_id: UNIT,
          project_id: PROJECT,
          responsible_counterparty_id: null,
          reported_at: "2026-10-02T09:00:00.000Z",
          description: "Yoke cracked.",
        }),
      ],
    },
    {
      // R7 (2692): custody is recorded through the scan; the fake appends the row it would write.
      record_asset_custody: (args, self) => {
        const row = tenantRow(id(91), ORG, {
          asset_unit_id: args["p_asset_unit_id"],
          custodian_membership_id: args["p_custodian_membership_id"] ?? null,
          custodian_engagement_id: args["p_custodian_engagement_id"] ?? null,
          venue_id: args["p_venue_id"] ?? null,
          project_id: args["p_project_id"] ?? null,
          note: args["p_note"] ?? null,
        });
        self.tables["asset_custody"]?.push(row);
        return row["id"];
      },
      transition_asset: (args, self) => {
        const unit = self.tables["asset_units"]?.find(
          (u) => u["id"] === args["p_asset_unit_id"],
        ) as Row;
        if (unit["asset_state"] !== args["p_expected"]) throw refusal("asset_state_conflict");
        if (args["p_next"] === "Retired") throw refusal("asset_transition_not_allowed");
        unit["asset_state"] = args["p_next"];
        return id(90);
      },
      resolve_asset_code: (args) => {
        const code = String(args["p_code"]);
        if (code.toUpperCase() === "MH-001" || code === "SPX-48810") {
          return [
            {
              subject_kind: "unit",
              subject_id: UNIT,
              asset_tag: "MH-001",
              class_name: "Spot Fixture",
              asset_state: "Available",
              home_venue_id: VENUE,
              custodian_membership_id: null,
              custodian_engagement_id: null,
              custody_venue_id: VENUE,
              custody_project_id: null,
              custody_since: null,
              lot_venue_id: null,
              on_hand: null,
              refusal: null,
              reason: null,
            },
          ];
        }
        if (code === `LOT:${LOT}`) {
          return [
            {
              subject_kind: "lot",
              subject_id: LOT,
              class_name: "Box Truss",
              lot_venue_id: VENUE,
              on_hand: 34,
              refusal: null,
              reason: null,
            },
          ];
        }
        return [
          {
            subject_kind: null,
            subject_id: null,
            refusal: "NO_ANSWER",
            rule: "asset_code_unknown",
          },
        ];
      },
      apply_asset_scan: (args, self) => {
        if (args["p_code"] === "GONE")
          throw refusal(
            "asset_code_unknown",
            "NO_ANSWER: no single asset or lot carries this code.",
          );
        const seen = self.tables["asset_custody"]?.some((c) => c["id"] === args["p_event_id"]);
        if (!seen) {
          self.tables["asset_custody"]?.push(
            tenantRow(String(args["p_event_id"]), ORG, {
              asset_unit_id: UNIT,
              custodian_membership_id: args["p_custodian_membership_id"],
            }),
          );
        }
        return [
          {
            outcome: seen ? "duplicate" : "applied",
            subject_kind: "unit",
            subject_id: UNIT,
            ledger_id: args["p_event_id"],
            asset_state: "Deployed",
            on_hand: null,
          },
        ];
      },
    },
    {
      asset_units: { asset_state: "Proposed", condition_enum_id: null, home_venue_id: null },
      asset_identifiers: { identifier_class: "identifier" },
      asset_custody: {
        custodian_membership_id: null,
        custodian_engagement_id: null,
        venue_id: null,
        project_id: null,
        note: null,
      },
      asset_maintenance: { cost_minor: null, currency_code: null },
      asset_damage: {
        project_id: null,
        responsible_counterparty_id: null,
        reported_at: "2026-10-03T10:00:00.000Z",
      },
    },
  );
  const app = contractApp({ handlers: [assets], db });
  return { db, http: requests(app) };
}

describe("Assets contract: asset classes", () => {
  it("lists, reads, creates, updates and archives an empty class", async () => {
    const { http, db } = world();
    const page = await expectContract(
      await success(http.get("/asset-classes")),
      "assetClasses.list",
    );
    expect((page as { data: Row[] }).data).toHaveLength(2);
    await expectContract(await success(http.get(`/asset-classes/${CLASS}`)), "assetClasses.get");
    const r1 = await success(
      http.post("/asset-classes", {
        name: "Towable Generator",
        element_id: "5000.06.01-XPMS-004",
      }),
    );
    const made = (await expectContract(r1, "assetClasses.create")) as Row;
    expect(made["element_id"]).toBe("5000.06.01-XPMS-004");
    const r2 = await success(http.patch(`/asset-classes/${CLASS}`, { name: "Spot Luminaire" }));
    await expectContract(r2, "assetClasses.update");
    expect((await http.patch(`/asset-classes/${CLASS}`, { name: "Late" }, STALE)).status).toBe(412);
    await expectContract(
      await success(http.delete(`/asset-classes/${EMPTY_CLASS}`)),
      "assetClasses.delete",
    );
    expect((await http.get(`/asset-classes/${EMPTY_CLASS}`)).status).toBe(404);
    expect(
      db.tables["asset_classes"]?.find((c) => c["id"] === EMPTY_CLASS)?.["deleted_at"],
    ).not.toBeNull();
  });

  it("refuses to archive a class that still holds units", async () => {
    const { http } = world();
    const refused = await http.delete(`/asset-classes/${CLASS}`);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ rule: "asset_class_in_use" });
  });
});

describe("Assets contract: units, lifecycle and scans", () => {
  it("lists, reads, registers, edits and archives units; the tag is fixed", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/asset-units")), "assetUnits.list");
    const unit = (await expectContract(
      await success(http.get(`/asset-units/${UNIT}`)),
      "assetUnits.get",
    )) as Row;
    expect(unit["home_venue_id"]).toBe(VENUE);
    const r3 = await success(
      http.post("/asset-units", { asset_class_id: CLASS, asset_tag: "MH-002" }),
    );
    const made = (await expectContract(r3, "assetUnits.create")) as Row;
    expect(made["asset_state"]).toBe("Proposed");
    const r4 = await success(http.patch(`/asset-units/${UNIT}`, { condition_enum_id: "ENM-018" }));
    await expectContract(r4, "assetUnits.update");
    expect(
      (await http.patch(`/asset-units/${UNIT}`, { condition_enum_id: null }, STALE)).status,
    ).toBe(412);
    await expectContract(await success(http.delete(`/asset-units/${UNIT}`)), "assetUnits.delete");
    expect((await http.get(`/asset-units/${UNIT}`)).status).toBe(404);
  });

  it("moves a unit along its lifecycle and refuses what the rules refuse", async () => {
    const { http } = world();
    const r5 = await success(
      http.post(`/asset-units/${UNIT}/transitions`, {
        expected_state: "Available",
        to_state: "Reserved",
        reason: "Held for NWS.",
      }),
    );
    const moved = (await expectContract(r5, "assetUnits.transition")) as Row;
    expect(moved["asset_state"]).toBe("Reserved");
    const stale = await http.post(`/asset-units/${UNIT}/transitions`, {
      expected_state: "Available",
      to_state: "Deployed",
      reason: "Out.",
    });
    expect(stale.status).toBe(422);
    const noReason = await http.post(`/asset-units/${UNIT}/transitions`, {
      expected_state: "Reserved",
      to_state: "Available",
    });
    expect(await noReason.json()).toMatchObject({ rule: "transition_reason_required" });
    expect(
      (
        await http.post(`/asset-units/${id(99)}/transitions`, {
          expected_state: "Available",
          to_state: "Reserved",
          reason: "x",
        })
      ).status,
    ).toBe(404);
  });

  it("resolves a scanned tag or serial to its unit, and answers NO_ANSWER otherwise", async () => {
    const { http } = world();
    const r6 = await success(
      http.post("/asset-units/scan", { code: "SPX-48810", symbology: "code128" }),
    );
    const unit = (await expectContract(r6, "assetUnits.scan")) as Row;
    expect(unit["asset_tag"]).toBe("MH-001");
    const unknown = await http.post("/asset-units/scan", { code: "NOPE", symbology: "qr" });
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({
      refusal: "NO_ANSWER",
      rule: "asset_code_unknown",
    });
    const lot = await http.post("/asset-units/scan", { code: `LOT:${LOT}`, symbology: "qr" });
    expect(await lot.json()).toMatchObject({ refusal: "NO_ANSWER", rule: "asset_scan_lot" });
  });

  it("applies a scan event once and answers duplicate on replay", async () => {
    const { http, db } = world();
    const body = {
      event_id: EVENT,
      code: "MH-001",
      action: "check-out",
      custodian_membership_id: MEMBER,
      project_id: PROJECT,
    };
    const r7 = await success(http.post("/asset-units/scans", body));
    const first = (await expectContract(r7, "assetUnits.applyScan")) as Row;
    expect(first).toMatchObject({ outcome: "applied", asset_state: "Deployed", ledger_id: EVENT });
    const r8 = await success(http.post("/asset-units/scans", body));
    const again = (await expectContract(r8, "assetUnits.applyScan")) as Row;
    expect(again["outcome"]).toBe("duplicate");
    expect(db.tables["asset_custody"]?.filter((c) => c["id"] === EVENT)).toHaveLength(1);
    expect(db.calls.find((c) => c.name === "apply_asset_scan")?.args).toMatchObject({
      p_event_id: EVENT,
      p_action: "check-out",
      p_custodian_membership_id: MEMBER,
      p_project_id: PROJECT,
    });
    const gone = await http.post("/asset-units/scans", { ...body, event_id: id(13), code: "GONE" });
    expect(gone.status).toBe(422);
    expect(await gone.json()).toMatchObject({ rule: "asset_code_unknown" });
  });
});

describe("Assets contract: lots", () => {
  it("serves lots with the quantity on hand and keeps the opening count fixed", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/asset-lots")),
      "assetLots.list",
    )) as { data: Row[] };
    expect(page.data[0]?.["on_hand"]).toBe(34);
    await expectContract(await success(http.get(`/asset-lots/${LOT}`)), "assetLots.get");
    const r9 = await success(
      http.post("/asset-lots", { asset_class_id: EMPTY_CLASS, venue_id: VENUE, quantity: 12 }),
    );
    const made = (await expectContract(r9, "assetLots.create")) as Row;
    expect(made["on_hand"]).toBe(12);
    const r10 = await success(http.patch(`/asset-lots/${LOT}`, { venue_id: VENUE }));
    await expectContract(r10, "assetLots.update");
    // The opening count is not an update field; a quantity sent anyway changes nothing.
    const kept = (await success(http.patch(`/asset-lots/${LOT}`, { quantity: 50 }))).json();
    expect(await kept).toMatchObject({ quantity: 40 });
    await expectContract(await success(http.delete(`/asset-lots/${LOT}`)), "assetLots.delete");
    expect((await http.get(`/asset-lots/${LOT}`)).status).toBe(404);
  });
});

describe("Assets contract: identifiers, custody, maintenance and damage", () => {
  it("records and removes identifiers", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/asset-identifiers")), "assetIdentifiers.list");
    await expectContract(
      await success(http.get(`/asset-identifiers/${IDENT}`)),
      "assetIdentifiers.get",
    );
    const r11 = await success(
      http.post("/asset-identifiers", {
        asset_unit_id: UNIT,
        scheme: "gtin14",
        value: "00012345600017",
      }),
    );
    const made = (await expectContract(r11, "assetIdentifiers.create")) as Row;
    expect(made["identifier_class"]).toBe("identifier");
    await expectContract(
      await success(http.delete(`/asset-identifiers/${IDENT}`)),
      "assetIdentifiers.delete",
    );
  });

  it("reads and appends to the custody ledger", async () => {
    const { http, db } = world();
    await expectContract(await success(http.get("/asset-custody")), "assetCustodyEntries.list");
    const entry = (await expectContract(
      await success(http.get(`/asset-custody/${CUSTODY}`)),
      "assetCustodyEntries.get",
    )) as Row;
    expect(entry["note"]).toBe("Issued for load-in.");
    const r12 = await success(
      http.post("/asset-custody", {
        asset_unit_id: UNIT,
        venue_id: VENUE,
        note: "Back on the shelf.",
      }),
    );
    await expectContract(r12, "assetCustodyEntries.create");
    expect(db.calls.find((c) => c.name === "record_asset_custody")?.args).toEqual({
      p_asset_unit_id: UNIT,
      p_venue_id: VENUE,
      p_note: "Back on the shelf.",
    });
    db.fail("rpc:record_asset_custody", refusal("asset_custody_somewhere"));
    expect((await http.post("/asset-custody", { asset_unit_id: UNIT })).status).toBe(422);
  });

  it("keeps an unknown maintenance cost null", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/asset-maintenance")),
      "assetMaintenanceEvents.list",
    )) as { data: Row[] };
    expect(page.data[0]?.["cost_minor"]).toBeNull();
    await expectContract(
      await success(http.get(`/asset-maintenance/${MAINT}`)),
      "assetMaintenanceEvents.get",
    );
    const r13 = await success(
      http.post("/asset-maintenance", {
        asset_unit_id: UNIT,
        performed_on: "2026-10-03",
        description: "Coolant flushed.",
        cost_minor: 12550,
        currency_code: "USD",
      }),
    );
    const made = (await expectContract(r13, "assetMaintenanceEvents.create")) as Row;
    expect(made["currency_code"]).toBe("USD");
    const r14 = await success(
      http.patch(`/asset-maintenance/${MAINT}`, { cost_minor: 18500, currency_code: "USD" }),
    );
    await expectContract(r14, "assetMaintenanceEvents.update");
    await expectContract(
      await success(http.delete(`/asset-maintenance/${MAINT}`)),
      "assetMaintenanceEvents.delete",
    );
  });

  it("reports, edits and removes damage", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/asset-damage")), "assetDamageReports.list");
    await expectContract(
      await success(http.get(`/asset-damage/${DAMAGE}`)),
      "assetDamageReports.get",
    );
    const r15 = await success(
      http.post("/asset-damage", { asset_unit_id: UNIT, description: "Antenna snapped." }),
    );
    const made = (await expectContract(r15, "assetDamageReports.create")) as Row;
    expect(made["project_id"]).toBeNull();
    const r16 = await success(http.patch(`/asset-damage/${DAMAGE}`, { project_id: null }));
    await expectContract(r16, "assetDamageReports.update");
    await expectContract(
      await success(http.delete(`/asset-damage/${DAMAGE}`)),
      "assetDamageReports.delete",
    );
    expect((await http.get(`/asset-damage/${DAMAGE}`)).status).toBe(404);
  });
});
