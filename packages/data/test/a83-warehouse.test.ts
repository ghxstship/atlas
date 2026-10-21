import { describe, expect, it } from "vitest";
import {
  changeWarehouseDestination,
  createWarehouseDestination,
  deliveryHour,
  listDeadLetters,
  listInboundSecretConnections,
  listWarehouseDeliveries,
  listWarehouseDestinations,
  listWarehouseProviders,
  listWithheldColumns,
  requestWarehouseDelivery,
  retryDeadLetter,
  storeInboundSecret,
  storeWarehouseCredential,
} from "../src/warehouse.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const ok = (data: unknown) => ({ data, error: null });
const refused = (rule: string) => ({
  data: null,
  error: { code: "XR001", message: `${rule}: no`, hint: rule },
});

describe("warehouse delivery settings", () => {
  it("reads providers, destinations, deliveries and the withheld columns", async () => {
    const { db, calls } = moduleClient({
      "from:warehouse_providers": [
        ok([
          { provider: "S3", available: true },
          { provider: "BigQuery", available: false },
        ]),
      ],
      "from:warehouse_destinations": [
        ok([
          {
            id: "d1",
            provider: "S3",
            display_name: "Lake",
            bucket_name: "northwind-lake",
            region: "us-east-1",
            endpoint_url: null,
            path_prefix: "xos",
            file_format: "Parquet",
            include_confidential: false,
            delivery_hour: 2,
            destination_state: "Active",
            next_delivery_at: "t1",
            credential_stored_at: null,
            last_delivered_at: null,
            last_error_message: null,
          },
        ]),
      ],
      "from:warehouse_deliveries": [
        ok([
          {
            id: "w1",
            warehouse_destination_id: "d1",
            delivery_state: "Delivered",
            requested_manually: true,
            created_at: "t",
            finished_at: "t2",
            tables_delivered: 19,
            rows_delivered: 120,
            columns_withheld: 3,
            error_message: null,
          },
        ]),
      ],
      "rpc:warehouse_published_schema": [
        ok([
          {
            table_key: "projects",
            column_name: "name",
            classification: null,
            delivered_with_confidential: true,
          },
          {
            table_key: "pay_rates",
            column_name: "rate_minor",
            classification: "Restricted",
            delivered_with_confidential: false,
          },
          {
            table_key: "engagements",
            column_name: "internal_note",
            classification: "Confidential",
            delivered_with_confidential: true,
          },
        ]),
      ],
    });
    expect(await listWarehouseProviders(db)).toEqual({
      ok: true,
      data: [
        { provider: "S3", available: true },
        { provider: "BigQuery", available: false },
      ],
    });
    const destinations = await listWarehouseDestinations(db, "o");
    expect(destinations.ok && destinations.data[0]).toMatchObject({
      id: "d1",
      fileFormat: "Parquet",
      deliveryHour: 2,
      state: "Active",
    });
    const deliveries = await listWarehouseDeliveries(db, "o");
    expect(deliveries.ok && deliveries.data[0]).toMatchObject({
      state: "Delivered",
      manual: true,
      columnsWithheld: 3,
    });
    const withheld = await listWithheldColumns(db);
    expect(withheld.ok && withheld.data).toEqual([
      {
        tableKey: "pay_rates",
        columnName: "rate_minor",
        classification: "Restricted",
        deliveredWithConfidential: false,
      },
      {
        tableKey: "engagements",
        columnName: "internal_note",
        classification: "Confidential",
        deliveredWithConfidential: true,
      },
    ]);
    expect(stepsOf(calls[1], "eq")).toContainEqual(["org_id", "o"]);
  });

  it("writes destinations through RLS and the warehouse RPCs, and reports refusals", async () => {
    const { db, calls } = moduleClient({
      "from:warehouse_destinations": [
        ok([{ id: "d2" }]),
        ok([{ id: "d2" }]),
        ok([{ id: "d2" }]),
        refused("warehouse_plan"),
      ],
      "rpc:store_warehouse_credential": [ok(null)],
      "rpc:request_warehouse_delivery": [ok("w2"), refused("warehouse_credential_required")],
    });
    expect(
      await createWarehouseDestination(db, {
        orgId: "o",
        provider: "S3",
        displayName: "Lake",
        bucketName: "northwind-lake",
        region: null,
        endpointUrl: null,
        pathPrefix: "xos",
        fileFormat: "CSV",
        includeConfidential: false,
        deliveryHour: 4,
      }),
    ).toEqual({ ok: true, data: "d2" });
    expect(stepsOf(calls[0], "insert")[0]?.[0]).toMatchObject({
      provider: "S3",
      file_format: "CSV",
      delivery_hour: 4,
    });
    expect(await changeWarehouseDestination(db, "d2", { state: "Paused" })).toEqual({
      ok: true,
      data: "d2",
    });
    expect(stepsOf(calls[1], "update")[0]).toEqual([{ destination_state: "Paused" }]);
    expect(await changeWarehouseDestination(db, "d2", { deleted: true })).toEqual({
      ok: true,
      data: "d2",
    });
    expect(
      Object.keys((stepsOf(calls[2], "update")[0]?.[0] as Record<string, unknown>) ?? {}),
    ).toEqual(["deleted_at"]);
    expect(await changeWarehouseDestination(db, "d2", { state: "Active" })).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "warehouse_plan", message: "no" },
    });
    expect(await storeWarehouseCredential(db, "d2", "{}")).toEqual({ ok: true, data: null });
    expect(await requestWarehouseDelivery(db, "d2")).toEqual({ ok: true, data: "w2" });
    expect((await requestWarehouseDelivery(db, "d2")).ok).toBe(false);
  });

  it("parses the delivery hour", () => {
    expect(deliveryHour("0")).toBe(0);
    expect(deliveryHour("23")).toBe(23);
    expect(deliveryHour("24")).toBeNull();
    expect(deliveryHour("2.5")).toBeNull();
    expect(deliveryHour("")).toBeNull();
    expect(deliveryHour("night")).toBeNull();
  });
});

describe("provider webhook settings", () => {
  it("lists dead letters and sends one back with a reason", async () => {
    const { db } = moduleClient({
      "from:integration_inbound_events": [
        ok([
          {
            id: "e1",
            provider_code: "slack",
            inbound_kind: "Link Unfurl",
            received_at: "t",
            attempt: 8,
            error_message: "Slack refused the token.",
          },
        ]),
      ],
      "rpc:retry_integration_inbound_event": [ok(null)],
    });
    const letters = await listDeadLetters(db, "o");
    expect(letters.ok && letters.data).toEqual([
      {
        id: "e1",
        providerCode: "slack",
        kind: "Link Unfurl",
        receivedAt: "t",
        attempts: 8,
        errorMessage: "Slack refused the token.",
      },
    ]);
    expect(await retryDeadLetter(db, "e1", "Token reinstalled.")).toEqual({ ok: true, data: null });
  });

  it("lists connections that take a webhook secret with when one was stored, and stores one", async () => {
    const { db } = moduleClient({
      "from:integration_connections": [
        ok([
          {
            id: "c1",
            provider_code: "microsoft_teams",
            display_name: "Teams",
            connection_state: "Connected",
          },
          {
            id: "c2",
            provider_code: "google_calendar",
            display_name: "Calendar",
            connection_state: "Pending",
          },
        ]),
        ok([]),
      ],
      "rpc:integration_inbound_secrets_stored": [
        ok([{ integration_connection_id: "c1", stored_at: "t" }]),
        refused("denied"),
      ],
      "rpc:store_integration_inbound_secret": [ok(null)],
    });
    const list = await listInboundSecretConnections(db, "o");
    expect(list.ok && list.data).toEqual([
      { connectionId: "c1", providerCode: "microsoft_teams", displayName: "Teams", storedAt: "t" },
      {
        connectionId: "c2",
        providerCode: "google_calendar",
        displayName: "Calendar",
        storedAt: null,
      },
    ]);
    expect((await listInboundSecretConnections(db, "o")).ok).toBe(false);
    expect(await storeInboundSecret(db, "c1", "s".repeat(20))).toEqual({ ok: true, data: null });
  });
});
