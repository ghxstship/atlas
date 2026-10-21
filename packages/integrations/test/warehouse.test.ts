import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { HttpRequest } from "../src/framework/http.ts";
import type { JobQueue } from "../src/framework/runner.ts";
import { thriftCompact, toParquetValue, writeParquet } from "../src/warehouse/parquet.ts";
import {
  unavailableProvider,
  warehouseProviders,
  type WarehouseTarget,
} from "../src/warehouse/provider.ts";
import {
  encodeKey,
  objectUrl,
  parseS3Credential,
  s3Failure,
  s3Provider,
  signPut,
} from "../src/warehouse/s3.ts";
import {
  deliveryPrefix,
  publicHostHttp,
  runWarehouseDeliveries,
  supabaseWarehouseStore,
  type ClaimedDelivery,
  type DeliveryColumn,
  type DeliveryFile,
  type WarehouseStore,
} from "../src/warehouse/worker.ts";
import type { publishedSchema } from "../src/warehouse/worker.ts";
import { dbError, okData, recordingDb, scriptedHttp } from "./doubles.ts";
import { readParquet } from "./parquet-reader.ts";

// A runtime-built credential; it signs nothing real.
const CREDENTIAL = JSON.stringify({
  access_key_id: ["test", "access", "key", "id"].join("-"),
  secret_access_key: ["test", "secret", "access", "key"].join("-"),
});

describe("Parquet writer", () => {
  it("writes a file a Parquet reader reads back, NULLs included", () => {
    const columns = [
      { name: "id", type: "string" as const },
      { name: "count", type: "int32" as const },
      { name: "amount_minor", type: "int64" as const },
      { name: "ratio", type: "double" as const },
      { name: "active", type: "boolean" as const },
      { name: "starts_on", type: "date" as const },
      { name: "created_at", type: "timestamp" as const },
    ];
    const rows = [
      ["a-1", 3, 1250n, 0.5, true, "2027-06-30", "2027-06-30T12:00:00.123456+00:00"],
      [null, null, null, null, false, null, null],
      ['Café, "quoted"', -7, 9007199254740993n, -1.25, null, "1970-01-02", "1970-01-01T00:00:01Z"],
    ];
    const file = writeParquet(columns, rows);
    const read = readParquet(file);
    expect(read.version).toBe(1);
    expect(read.numRows).toBe(3n);
    expect(read.createdBy).toBe("XOS warehouse delivery");
    expect(read.columns.map((c) => c.name)).toEqual(columns.map((c) => c.name));
    expect(read.columns.map((c) => c.physical)).toEqual([6, 1, 2, 5, 0, 1, 2]);
    expect(read.columns.map((c) => c.converted)).toEqual([0, null, null, null, null, 6, 10]);
    expect(read.columns[0]?.values).toEqual(["a-1", null, 'Café, "quoted"']);
    expect(read.columns[1]?.values).toEqual([3, null, -7]);
    expect(read.columns[2]?.values).toEqual([1250n, null, 9007199254740993n]);
    expect(read.columns[3]?.values).toEqual([0.5, null, -1.25]);
    expect(read.columns[4]?.values).toEqual([true, false, null]);
    expect(read.columns[5]?.values).toEqual([20999, null, 1]);
    expect(read.columns[6]?.values).toEqual([1_814_356_800_123_456n, null, 1_000_000n]);
    // TIMESTAMP(isAdjustedToUTC = true, unit = MICROS) as the logical type of the timestamp column.
    const logical = read.columns[6]?.logical?.get(8) as Map<number, unknown>;
    expect(logical.get(1)).toBe(true);
    expect((logical.get(2) as Map<number, unknown>).has(2)).toBe(true);
  });

  it("writes an empty table and refuses a file without columns or with bad values", () => {
    const read = readParquet(writeParquet([{ name: "id", type: "string" }], []));
    expect(read.numRows).toBe(0n);
    expect(read.columns[0]?.values).toEqual([]);
    expect(() => writeParquet([], [])).toThrow("at least one column");
    expect(() => writeParquet([{ name: "n", type: "int32" }], [[1.5]])).toThrow("not an int32");
    expect(() => writeParquet([{ name: "d", type: "date" }], [["soon"]])).toThrow("not a date");
    expect(() => writeParquet([{ name: "t", type: "timestamp" }], [["later"]])).toThrow(
      "not a timestamp",
    );
  });

  it("encodes long lists and far field ids in the compact protocol", () => {
    const many = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const bytes = thriftCompact([
      { id: 40, strs: many },
      { id: 1, i32s: [1, -1] },
    ]);
    expect(bytes[0]).toBe(0x19); // field 1, list
    expect(bytes.includes(0xf8)).toBe(true); // a list of 15 or more binaries
    expect(bytes[bytes.length - 1]).toBe(0);
  });

  it("normalizes database values into column types", () => {
    expect(toParquetValue("string", { a: 1 })).toBe('{"a":1}');
    expect(toParquetValue("string", "x")).toBe("x");
    expect(toParquetValue("boolean", "true")).toBe(true);
    expect(toParquetValue("double", "1.5")).toBe(1.5);
    expect(toParquetValue("int64", 12)).toBe(12);
    expect(toParquetValue("date", "2027-01-01")).toBe("2027-01-01");
    expect(toParquetValue("int32", undefined)).toBeNull();
  });
});

describe("S3 provider", () => {
  const aws: WarehouseTarget = {
    provider: "S3",
    bucket: "northwind-lake",
    region: "eu-west-1",
    endpointUrl: null,
  };
  const compatible: WarehouseTarget = {
    provider: "S3",
    bucket: "northwind-lake",
    region: null,
    endpointUrl: "https://objects.example-storage.test/",
  };

  it("addresses AWS virtual-hosted and compatible path-style endpoints", () => {
    expect(objectUrl(aws, "xos/2027-06-30/d/records.parquet").toString()).toBe(
      "https://northwind-lake.s3.eu-west-1.amazonaws.com/xos/2027-06-30/d/records.parquet",
    );
    expect(objectUrl(compatible, "a b/c(1).csv").toString()).toBe(
      "https://objects.example-storage.test/northwind-lake/a%20b/c%281%29.csv",
    );
    expect(encodeKey("x/it's*")).toBe("x/it%27s%2A");
  });

  it("signs PutObject with Signature Version 4", () => {
    const credential = parseS3Credential(CREDENTIAL);
    const body = new TextEncoder().encode("id\r\n1\r\n");
    const now = new Date("2027-06-30T12:00:00.000Z");
    const signed = signPut(aws, credential, "xos/records.csv", body, "text/csv", now);
    const payload = createHash("sha256").update(body).digest("hex");
    expect(signed.headers["x-amz-content-sha256"]).toBe(payload);
    expect(signed.headers["x-amz-date"]).toBe("20270630T120000Z");
    const canonical = [
      "PUT",
      "/xos/records.csv",
      "",
      "content-type:text/csv",
      "host:northwind-lake.s3.eu-west-1.amazonaws.com",
      `x-amz-content-sha256:${payload}`,
      "x-amz-date:20270630T120000Z",
      "",
      "content-type;host;x-amz-content-sha256;x-amz-date",
      payload,
    ].join("\n");
    const scope = "20270630/eu-west-1/s3/aws4_request";
    const toSign = [
      "AWS4-HMAC-SHA256",
      "20270630T120000Z",
      scope,
      createHash("sha256").update(canonical).digest("hex"),
    ].join("\n");
    let key: Buffer = createHmac("sha256", `AWS4${credential.secretAccessKey}`)
      .update("20270630")
      .digest();
    for (const part of ["eu-west-1", "s3", "aws4_request"])
      key = createHmac("sha256", key).update(part).digest();
    const signature = createHmac("sha256", key).update(toSign).digest("hex");
    expect(signed.headers["authorization"]).toBe(
      `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    );
    expect(signed.headers["host"]).toBeUndefined();
    const session = signPut(
      compatible,
      { ...credential, sessionToken: "session" },
      "k",
      body,
      "text/csv",
      now,
    );
    expect(session.headers["x-amz-security-token"]).toBe("session");
    expect(session.headers["authorization"]).toContain("/us-east-1/s3/aws4_request");
    expect(session.headers["authorization"]).toContain("x-amz-security-token");
  });

  it("refuses a malformed credential and classifies bucket errors", () => {
    expect(() => parseS3Credential("not json")).toThrow("access_key_id and secret_access_key");
    expect(() => parseS3Credential('{"access_key_id":"a"}')).toThrow("access_key_id");
    expect(
      parseS3Credential(
        JSON.stringify({ access_key_id: "a", secret_access_key: "b", session_token: "" }),
      ).sessionToken,
    ).toBeNull();
    expect(s3Failure(403, "<Code>AccessDenied</Code>")).toMatchObject({
      code: "warehouse_access_denied",
      retryable: false,
    });
    expect(s3Failure(404, "")).toMatchObject({ code: "warehouse_bucket_missing" });
    expect(s3Failure(400, "<Code>NoSuchBucket</Code>")).toMatchObject({
      code: "warehouse_bucket_missing",
    });
    expect(s3Failure(503, "<Code>SlowDown</Code>")).toMatchObject({
      code: "warehouse_unavailable",
      retryable: true,
    });
    expect(s3Failure(400, "<Code>InvalidArgument</Code>").message).toBe(
      "The bucket answered 400 InvalidArgument.",
    );
  });

  it("puts an object and surfaces the bucket's refusal", async () => {
    const http = scriptedHttp([
      {
        match: "PUT https://northwind-lake.s3.eu-west-1.amazonaws.com/ok",
        respond: () => ({ status: 200 }),
      },
      {
        match: "PUT https://northwind-lake.s3.eu-west-1.amazonaws.com/denied",
        respond: () => ({ status: 403, body: "<Code>AccessDenied</Code>" }),
      },
    ]);
    const provider = s3Provider(http.http, () => new Date("2027-06-30T12:00:00Z"));
    await provider.put(aws, CREDENTIAL, {
      key: "ok",
      body: new Uint8Array([1]),
      contentType: "application/octet-stream",
    });
    expect(http.requests[0]?.headers?.["x-amz-date"]).toBe("20270630T120000Z");
    await expect(
      provider.put(aws, CREDENTIAL, { key: "denied", body: new Uint8Array(), contentType: "x" }),
    ).rejects.toMatchObject({
      code: "warehouse_access_denied",
    });
  });

  it("names the other providers and refuses to deliver to them", async () => {
    const providers = warehouseProviders([s3Provider(scriptedHttp([]).http)]);
    expect([...providers.keys()]).toEqual([
      "S3",
      "Google Cloud Storage",
      "Azure Blob",
      "BigQuery",
      "Snowflake",
    ]);
    expect(providers.get("S3")?.available).toBe(true);
    expect(providers.get("BigQuery")?.available).toBe(false);
    await expect(
      unavailableProvider("Snowflake").put(aws, "", {
        key: "k",
        body: new Uint8Array(),
        contentType: "x",
      }),
    ).rejects.toMatchObject({
      code: "warehouse_provider_unavailable",
    });
  });

  it("refuses endpoints that resolve to private addresses", async () => {
    const http = scriptedHttp([{ match: "PUT https://", respond: () => ({ status: 200 }) }]);
    const request: HttpRequest = { method: "PUT", url: "https://objects.example-storage.test/b/k" };
    await expect(
      publicHostHttp(http.http, async () => ["10.0.0.5"])(request),
    ).rejects.toMatchObject({ code: "warehouse_private_endpoint" });
    await expect(publicHostHttp(http.http, async () => [])(request)).rejects.toMatchObject({
      code: "warehouse_private_endpoint",
    });
    await expect(
      publicHostHttp(http.http, async () => [])({ ...request, url: "https://127.0.0.1/b/k" }),
    ).rejects.toMatchObject({
      code: "warehouse_private_endpoint",
    });
    expect((await publicHostHttp(http.http, async () => ["93.184.216.34"])(request)).status).toBe(
      200,
    );
  });
});

// The delivery worker -----------------------------------------------------------------------------------------------

const COLUMNS: DeliveryColumn[] = [
  {
    tableKey: "projects",
    columnName: "id",
    ordinal: 1,
    dataType: "string",
    classification: null,
    delivered: true,
    withheldReason: null,
  },
  {
    tableKey: "projects",
    columnName: "name",
    ordinal: 2,
    dataType: "string",
    classification: null,
    delivered: true,
    withheldReason: null,
  },
  {
    tableKey: "pay_rates",
    columnName: "id",
    ordinal: 1,
    dataType: "string",
    classification: null,
    delivered: true,
    withheldReason: null,
  },
  {
    tableKey: "pay_rates",
    columnName: "rate_minor",
    ordinal: 2,
    dataType: "int64",
    classification: "Restricted",
    delivered: false,
    withheldReason: "restricted",
  },
  {
    tableKey: "pay_rates",
    columnName: "tin_encrypted",
    ordinal: 3,
    dataType: "binary",
    classification: null,
    delivered: false,
    withheldReason: "encrypted",
  },
];

function claimed(overrides: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  return {
    id: "del-1",
    orgId: "org-1",
    destinationId: "dest-1",
    target: { provider: "S3", bucket: "northwind-lake", region: "us-east-1", endpointUrl: null },
    pathPrefix: "xos",
    format: "Parquet",
    includeConfidential: false,
    attempt: 1,
    snapshotAt: "2027-07-01T02:00:00.000000+00:00",
    // 02:00 UTC on 1 July is still 30 June in New York: the folder carries the org's date.
    snapshotDate: "2027-06-30",
    timeZone: "America/New_York",
    ...overrides,
  };
}

function memoryWarehouse(
  options: {
    delivery?: ClaimedDelivery | null;
    rows?: Record<string, Record<string, unknown>[]>;
    claimError?: Error;
  } = {},
) {
  const files: DeliveryFile[] = [];
  const events: string[] = [];
  const reads: { table: string; after: string | null; limit: number }[] = [];
  const store: WarehouseStore = {
    queueDue: async () => 1,
    claim: async () => {
      if (options.claimError) throw options.claimError;
      return options.delivery === undefined ? claimed() : options.delivery;
    },
    columns: async () => COLUMNS,
    async rows(_d, table, after, limit) {
      reads.push({ table, after, limit });
      const all = options.rows?.[table] ?? [];
      const start = after === null ? 0 : all.findIndex((r) => r["id"] === after) + 1;
      return all.slice(start, start + limit);
    },
    credential: async () => CREDENTIAL,
    recordFile: async (_d, file) => {
      files.push(file);
    },
    complete: async (_d, prefix, version) => {
      events.push(`complete ${prefix} v${version}`);
    },
    fail: async (_d, code, _m, retryable) => {
      events.push(`fail ${code} ${retryable}`);
      return retryable ? "Retrying" : "Failed";
    },
  };
  return { store, files, events, reads };
}

function jobs(ids: string[]) {
  const finished: [string, boolean][] = [];
  const queue: JobQueue = {
    claim: async () => ids.map((id, i) => ({ id: `job-${i}`, subjectId: id, attempts: 1 })),
    finish: async (id, ok) => {
      finished.push([id, ok]);
      return ok ? "Succeeded" : "Queued";
    },
  };
  return { queue, finished };
}

describe("warehouse delivery worker", () => {
  it("writes every table, withholds classified and encrypted columns, then the schema and the manifest", async () => {
    const w = memoryWarehouse({
      rows: {
        projects: [
          { id: "p1", name: "Summer Series", org_id: "org-1" },
          { id: "p2", name: "Winter Gala" },
        ],
        pay_rates: [{ id: "r1", rate_minor: 4200 }],
      },
    });
    const http = scriptedHttp([
      {
        match: "PUT https://northwind-lake.s3.us-east-1.amazonaws.com/",
        respond: () => ({ status: 200 }),
      },
    ]);
    const q = jobs(["del-1"]);
    const result = await runWarehouseDeliveries({
      queue: q.queue,
      store: w.store,
      providers: warehouseProviders([s3Provider(http.http)]),
      worker: "w",
    });
    expect(result).toEqual({
      queued: 1,
      outcomes: [{ deliveryId: "del-1", result: "delivered", files: 2, rows: 3 }],
    });
    expect(http.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/xos/2027-06-30/del-1/projects.parquet",
      "/xos/2027-06-30/del-1/pay_rates.parquet",
      "/xos/2027-06-30/del-1/_schema.json",
      "/xos/2027-06-30/del-1/_manifest.json",
    ]);
    const payRates = readParquet(http.requests[1]?.body as Uint8Array);
    expect(payRates.columns.map((c) => c.name)).toEqual(["id"]);
    const projects = readParquet(http.requests[0]?.body as Uint8Array);
    expect(projects.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(projects.columns[1]?.values).toEqual(["Summer Series", "Winter Gala"]);
    expect(
      w.files.map((f) => [f.tableKey, f.rowCount, f.columnsDelivered, f.columnsWithheld]),
    ).toEqual([
      ["projects", 2, 2, 0],
      ["pay_rates", 1, 1, 2],
    ]);
    expect(w.files[0]?.sha256).toBe(
      createHash("sha256")
        .update(http.requests[0]?.body as Uint8Array)
        .digest("hex"),
    );
    const schema = JSON.parse(
      new TextDecoder().decode(http.requests[2]?.body as Uint8Array),
    ) as ReturnType<typeof publishedSchema>;
    expect(schema.tables[1]?.withheld).toEqual([
      { name: "rate_minor", reason: "restricted" },
      { name: "tin_encrypted", reason: "encrypted" },
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(http.requests[3]?.body as Uint8Array)) as {
      files: unknown[];
      schema_version: string;
    };
    expect(manifest.files).toHaveLength(2);
    expect(manifest.schema_version).toBe("1");
    expect(manifest).toMatchObject({ snapshot_date: "2027-06-30", time_zone: "America/New_York" });
    expect(w.events).toEqual(["complete xos/2027-06-30/del-1 v1"]);
    expect(q.finished).toEqual([["job-0", true]]);
  });

  it("splits a large table into parts and writes CSV with formula-safe fields", async () => {
    const projects = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      name: i === 0 ? "=HYPERLINK(1)" : `Show ${i}`,
    }));
    const w = memoryWarehouse({
      delivery: claimed({ format: "CSV" }),
      rows: { projects, pay_rates: [] },
    });
    const http = scriptedHttp([{ match: "PUT https://", respond: () => ({ status: 200 }) }]);
    await runWarehouseDeliveries({
      queue: jobs(["del-1"]).queue,
      store: w.store,
      providers: warehouseProviders([s3Provider(http.http)]),
      worker: "w",
      partRows: 2,
    });
    expect(w.files.map((f) => [f.objectKey.split("/").pop(), f.rowCount])).toEqual([
      ["projects.part-0001.csv", 2],
      ["projects.part-0002.csv", 2],
      ["projects.part-0003.csv", 1],
      ["pay_rates.csv", 0],
    ]);
    expect(new TextDecoder().decode(http.requests[0]?.body as Uint8Array)).toBe(
      "id,name\r\np0,'=HYPERLINK(1)\r\np1,Show 1\r\n",
    );
  });

  it("does not leave a trailing empty part when a table fills its last part exactly", async () => {
    const w = memoryWarehouse({
      rows: { projects: [{ id: "a" }, { id: "b" }], pay_rates: [{ id: "r" }] },
    });
    await runWarehouseDeliveries({
      queue: jobs(["del-1"]).queue,
      store: w.store,
      providers: warehouseProviders([
        s3Provider(
          scriptedHttp([{ match: "PUT https://", respond: () => ({ status: 200 }) }]).http,
        ),
      ]),
      worker: "w",
      partRows: 2,
    });
    expect(w.files.map((f) => f.objectKey.split("/").pop())).toEqual([
      "projects.part-0001.parquet",
      "pay_rates.parquet",
    ]);
  });

  it("retries an unavailable bucket and fails a refused credential for good", async () => {
    const retry = memoryWarehouse({ rows: { projects: [{ id: "p" }] } });
    const outage = scriptedHttp([{ match: "PUT https://", respond: () => ({ status: 503 }) }]);
    const first = await runWarehouseDeliveries({
      queue: jobs(["del-1"]).queue,
      store: retry.store,
      providers: warehouseProviders([s3Provider(outage.http)]),
      worker: "w",
    });
    expect(first.outcomes).toEqual([
      { deliveryId: "del-1", result: "retrying", code: "warehouse_unavailable" },
    ]);
    expect(retry.events).toEqual(["fail warehouse_unavailable true"]);

    const denied = memoryWarehouse({ rows: { projects: [{ id: "p" }] } });
    const refused = scriptedHttp([{ match: "PUT https://", respond: () => ({ status: 403 }) }]);
    const second = await runWarehouseDeliveries({
      queue: jobs(["del-1"]).queue,
      store: denied.store,
      providers: warehouseProviders([s3Provider(refused.http)]),
      worker: "w",
    });
    expect(second.outcomes).toEqual([
      { deliveryId: "del-1", result: "failed", code: "warehouse_access_denied" },
    ]);
  });

  it("fails a delivery to a provider that is not built and skips one the claim refused", async () => {
    const w = memoryWarehouse({
      delivery: claimed({
        target: { provider: "BigQuery", bucket: "b", region: null, endpointUrl: null },
      }),
    });
    const out = await runWarehouseDeliveries({
      queue: jobs(["del-1"]).queue,
      store: w.store,
      providers: warehouseProviders([]),
      worker: "w",
    });
    expect(out.outcomes).toEqual([
      { deliveryId: "del-1", result: "failed", code: "warehouse_provider_unavailable" },
    ]);
    const gone = memoryWarehouse({ delivery: null });
    const skipped = await runWarehouseDeliveries({
      queue: jobs(["del-2"]).queue,
      store: gone.store,
      providers: warehouseProviders([]),
      worker: "w",
    });
    expect(skipped.outcomes).toEqual([
      { deliveryId: "del-2", result: "skipped", reason: "warehouse_destination_unavailable" },
    ]);
  });

  it("skips a delivery that is not pending and keeps the job when the database is unreachable", async () => {
    const { StoreError } = await import("../src/framework/db.ts");
    const refused = memoryWarehouse({
      claimError: new StoreError({
        kind: "refusal",
        rule: "warehouse_delivery_not_pending",
        message: "x",
      }),
    });
    const a = await runWarehouseDeliveries({
      queue: jobs(["d"]).queue,
      store: refused.store,
      providers: warehouseProviders([]),
      worker: "w",
    });
    expect(a.outcomes).toEqual([
      { deliveryId: "d", result: "skipped", reason: "warehouse_delivery_not_pending" },
    ]);
    const down = memoryWarehouse({ claimError: new Error("connection reset") });
    const q = jobs(["d"]);
    const b = await runWarehouseDeliveries({
      queue: q.queue,
      store: down.store,
      providers: warehouseProviders([]),
      worker: "w",
    });
    expect(b.outcomes).toEqual([{ deliveryId: "d", result: "skipped", reason: "runner_error" }]);
    expect(q.finished).toEqual([["job-0", false]]);
  });

  it("names each delivery's folder by snapshot date and id", () => {
    expect(deliveryPrefix(claimed({ pathPrefix: "lake/xos" }))).toBe("lake/xos/2027-06-30/del-1");
  });
});

describe("warehouse store", () => {
  it("calls the service-role RPCs of migration 1401", async () => {
    const r = recordingDb({
      "rpc:queue_due_warehouse_deliveries": [okData(2)],
      "rpc:claim_warehouse_delivery": [
        okData([
          {
            delivery_id: "d",
            org_id: "o",
            destination_id: "x",
            provider: "S3",
            bucket_name: "b",
            region: "auto",
            endpoint_url: "https://e.test",
            path_prefix: "xos",
            file_format: "CSV",
            include_confidential: true,
            attempt: 2,
            snapshot_at: "2027-06-30T02:00:00+00:00",
            snapshot_date: "2027-06-29",
            time_zone: "America/Los_Angeles",
          },
        ]),
        okData([]),
      ],
      "rpc:warehouse_delivery_columns": [
        okData([
          {
            table_key: "t",
            column_name: "c",
            ordinal: 1,
            data_type: "string",
            classification: null,
            delivered: true,
            withheld_reason: null,
          },
        ]),
      ],
      "rpc:warehouse_table_rows": [okData([{ id: "1" }])],
      "rpc:read_warehouse_credential": [okData("secret")],
      "rpc:record_warehouse_delivery_file": [okData("f")],
      "rpc:complete_warehouse_delivery": [okData(null)],
      "rpc:fail_warehouse_delivery": [
        okData("Retrying"),
        dbError("XR001", "warehouse_delivery_not_running: x", "warehouse_delivery_not_running"),
      ],
    });
    const store = supabaseWarehouseStore(r.db);
    expect(await store.queueDue()).toBe(2);
    expect(await store.claim("d")).toMatchObject({
      id: "d",
      format: "CSV",
      snapshotDate: "2027-06-29",
      timeZone: "America/Los_Angeles",
      target: { region: "auto", endpointUrl: "https://e.test" },
      attempt: 2,
    });
    expect(await store.claim("d")).toBeNull();
    expect(await store.columns("d")).toEqual([
      {
        tableKey: "t",
        columnName: "c",
        ordinal: 1,
        dataType: "string",
        classification: null,
        delivered: true,
        withheldReason: null,
      },
    ]);
    expect(await store.rows("d", "t", null, 10)).toEqual([{ id: "1" }]);
    expect(await store.credential("x")).toBe("secret");
    await store.recordFile("d", {
      tableKey: "t",
      objectKey: "k",
      rowCount: 1,
      byteCount: 2,
      sha256: "a".repeat(64),
      columnsDelivered: 1,
      columnsWithheld: 0,
    });
    await store.complete("d", "xos/2027-06-30/d", "1");
    expect(await store.fail("d", "c", "m", true)).toBe("Retrying");
    await expect(store.fail("d", "c", "m", true)).rejects.toThrow();
    expect(r.calls.find((c) => c.target === "rpc:warehouse_table_rows")?.steps[0]).toEqual([
      "args",
      [{ p_delivery_id: "d", p_table_key: "t", p_after: null, p_limit: 10 }],
    ]);
  });
});
