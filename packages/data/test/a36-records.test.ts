import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  addObjectField,
  boardField,
  calendarField,
  createObjectRecord,
  createObjectType,
  displayValue,
  getObjectType,
  keyFromLabel,
  listObjectRecords,
  listObjectTypes,
  setObjectValue,
  valueColumns,
  type ObjectType,
} from "../src/custom-objects.ts";
import {
  actOnInboxItem,
  isActionableApproval,
  listInbox,
  snoozeInboxItem,
  snoozeUntil,
} from "../src/inbox.ts";
import {
  buildOrgExport,
  canExportOrg,
  cancelOrganization,
  daysUntil,
  getCancellation,
  listExportTables,
  listOrgExports,
  reactivateOrganization,
  recordOrgExport,
  toCsv,
} from "../src/lifecycle.ts";
import { crc32, zip, ZipLimitError } from "../src/zip.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const ok = (data: unknown) => ({ data, error: null });
const refused = (rule: string) => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});
const denied = { data: null, error: { code: "42501", message: "denied" } };

const TYPE_ROW = {
  id: "t1",
  object_key: "gear_requests",
  label: "Gear Requests",
  icon: "box",
  default_view: "Board",
  custom_object_fields: [
    {
      id: "f2",
      field_key: "due",
      label: "Due",
      data_type: "Date",
      required: false,
      filterable: false,
      sort_order: 2,
      deleted_at: null,
      custom_object_field_choices: [],
    },
    {
      id: "f1",
      field_key: "stage",
      label: "Stage",
      data_type: "Choice",
      required: true,
      filterable: true,
      sort_order: 1,
      deleted_at: null,
      custom_object_field_choices: [
        { id: "c2", choice_key: "done", label: "Done", sort_order: 2, deleted_at: null },
        { id: "c1", choice_key: "new", label: "New", sort_order: 1, deleted_at: null },
        { id: "c3", choice_key: "old", label: "Old", sort_order: 3, deleted_at: "t" },
      ],
    },
    {
      id: "f9",
      field_key: "gone",
      label: "Gone",
      data_type: "Text",
      required: false,
      filterable: false,
      sort_order: 9,
      deleted_at: "t",
      custom_object_field_choices: [],
    },
    {
      id: "f3",
      field_key: "budget",
      label: "Budget",
      data_type: "Money",
      required: false,
      filterable: false,
      sort_order: 3,
      deleted_at: null,
      custom_object_field_choices: [],
    },
  ],
};

describe("custom objects repository", () => {
  it("reads types with ordered live fields and choices", async () => {
    const { db } = moduleClient({
      "from:custom_object_types": [ok([TYPE_ROW]), ok([TYPE_ROW]), ok([])],
    });
    const types = await listObjectTypes(db, "o");
    expect(types.ok && types.data[0]?.fields.map((f) => f.key)).toEqual(["stage", "due", "budget"]);
    const type = await getObjectType(db, "o", "gear_requests");
    expect(type.ok && type.data.fields[0]?.choices.map((c) => c.label)).toEqual(["New", "Done"]);
    const missing = await getObjectType(db, "o", "nope");
    expect(missing.ok === false && missing.error.kind).toBe("not-found");
  });

  it("defines a type and fields, adding choices to a Choice field", async () => {
    const { db, calls } = moduleClient({
      "from:custom_object_types": [ok([{ id: "t1" }])],
      "from:custom_object_fields": [ok([{ id: "f1" }]), ok([{ id: "f2" }]), ok([{ id: "f3" }])],
      "from:custom_object_field_choices": [ok(null), refused("custom_choice")],
    });
    expect(
      await createObjectType(db, {
        orgId: "o",
        key: "gear_requests",
        label: "Gear Requests",
        icon: "box",
        defaultView: "Board",
      }),
    ).toEqual({ ok: true, data: "t1" });
    expect(
      await addObjectField(db, {
        typeId: "t1",
        key: "stage",
        label: "Stage",
        dataType: "Choice",
        required: true,
        order: 1,
        choices: ["New", "In Review"],
      }),
    ).toEqual({ ok: true, data: "f1" });
    expect(stepsOf(calls[2], "insert")[0]?.[0]).toEqual([
      { custom_object_field_id: "f1", choice_key: "new", label: "New", sort_order: 1 },
      { custom_object_field_id: "f1", choice_key: "in_review", label: "In Review", sort_order: 2 },
    ]);
    expect(
      await addObjectField(db, {
        typeId: "t1",
        key: "due",
        label: "Due",
        dataType: "Date",
        required: false,
        order: 2,
      }),
    ).toEqual({ ok: true, data: "f2" });
    const failed = await addObjectField(db, {
      typeId: "t1",
      key: "x",
      label: "X",
      dataType: "Choice",
      required: false,
      order: 3,
      choices: ["9"],
    });
    expect(failed.ok).toBe(false);
    expect(keyFromLabel("  Due Date (local) ")).toBe("due_date_local");
    expect(keyFromLabel("2026 Season")).toBe("season");
  });

  it("lists records with typed values and writes records and values", async () => {
    const type = (await getObjectType(
      moduleClient({ "from:custom_object_types": [ok([TYPE_ROW])] }).db,
      "o",
      "k",
    )) as { ok: true; data: ObjectType };
    const { db, calls } = moduleClient({
      "from:custom_object_records": [
        ok([
          {
            id: "r1",
            title: "Truss for Main Stage",
            created_at: "t",
            updated_at: "t",
            custom_object_values: [
              { custom_object_field_id: "f1", value_choice_id: "c1", deleted_at: null },
              { custom_object_field_id: "f2", value_date: "2027-03-01", deleted_at: null },
              {
                custom_object_field_id: "f3",
                value_money_minor: null,
                value_currency: "USD",
                deleted_at: null,
              },
              { custom_object_field_id: "f9", value_text: "gone", deleted_at: null },
              { custom_object_field_id: "f2", value_date: "2020-01-01", deleted_at: "t" },
            ],
          },
        ]),
        ok([{ id: "r2" }]),
        ok([{ id: "r3" }]),
        denied,
      ],
      "from:custom_object_values": [
        ok(null),
        ok([]),
        ok([{ id: "v1" }]),
        ok([{ id: "v1" }]),
        ok([{ id: "v1" }]),
        ok([{ id: "v2" }]),
      ],
    });
    const records = await listObjectRecords(db, type.data);
    expect(records.ok && records.data[0]?.values).toEqual({
      f1: { kind: "choice", choiceId: "c1" },
      f2: { kind: "date", value: "2027-03-01" },
      f3: { kind: "money", minor: null, currency: "USD" },
    });
    expect(
      await createObjectRecord(db, {
        orgId: "o",
        typeId: "t1",
        title: "Speakers",
        values: { f1: { kind: "choice", choiceId: "c1" } },
      }),
    ).toEqual({ ok: true, data: "r2" });
    expect(
      await createObjectRecord(db, { orgId: "o", typeId: "t1", title: "Cable", values: {} }),
    ).toEqual({ ok: true, data: "r3" });
    expect(
      (await createObjectRecord(db, { orgId: "o", typeId: "t1", title: "No", values: {} })).ok,
    ).toBe(false);
    expect(
      await setObjectValue(db, {
        recordId: "r1",
        fieldId: "f1",
        value: { kind: "choice", choiceId: "c2" },
      }),
    ).toEqual({ ok: true, data: "v1" });
    expect(
      calls.filter(
        (c) => c.target === "from:custom_object_values" && stepsOf(c, "insert").length > 0,
      ),
    ).toHaveLength(2);
    expect(
      await setObjectValue(db, {
        recordId: "r1",
        fieldId: "f1",
        value: { kind: "choice", choiceId: "c1" },
      }),
    ).toEqual({ ok: true, data: "v1" });
    expect(boardField(type.data)?.key).toBe("stage");
    expect(calendarField(type.data)?.key).toBe("due");
    expect(boardField({ ...type.data, fields: [] })).toBeNull();
    expect(calendarField({ ...type.data, fields: [] })).toBeNull();
    const stage = type.data.fields[0];
    if (!stage) throw new Error("no field");
    expect(displayValue(stage, { kind: "choice", choiceId: "c2" })).toBe("Done");
    expect(displayValue(stage, undefined)).toBeNull();
    expect(displayValue(stage, { kind: "number", value: 3 })).toBe("3");
    expect(displayValue(stage, { kind: "boolean", value: true })).toBe("true");
    expect(displayValue(stage, { kind: "money", minor: null, currency: "USD" })).toBeNull();
    expect(displayValue(stage, { kind: "money", minor: 100, currency: "USD" })).toBe("100 USD");
    expect(displayValue(stage, { kind: "person", personId: "p1" })).toBe("p1");
    expect(displayValue(stage, { kind: "text", value: "x" })).toBe("x");
  });

  it("fills only the typed column of each value kind", () => {
    expect(valueColumns({ kind: "text", value: "a" })["value_text"]).toBe("a");
    expect(valueColumns({ kind: "number", value: 2 })["value_number"]).toBe(2);
    expect(valueColumns({ kind: "money", minor: 5, currency: "EUR" })).toMatchObject({
      value_money_minor: 5,
      value_currency: "EUR",
      value_text: null,
    });
    expect(valueColumns({ kind: "date", value: "2027-01-01" })["value_date"]).toBe("2027-01-01");
    expect(valueColumns({ kind: "timestamp", value: "t" })["value_timestamp"]).toBe("t");
    expect(valueColumns({ kind: "boolean", value: false })["value_boolean"]).toBe(false);
    expect(valueColumns({ kind: "person", personId: "p" })["value_person_id"]).toBe("p");
  });
});

describe("inbox repository", () => {
  it("lists Needs You first with the approval, and acts and snoozes", async () => {
    const { db, calls } = moduleClient({
      "from:inbox_items": [
        ok([
          {
            id: "n2",
            created_at: "2026-10-16T10:00:00Z",
            kind: "approval.decided",
            section: "For Your Information",
            read_at: "t",
            subject_table: "approval_instances",
            subject_id: "a0",
            project_id: null,
            message_args: { title: "PO 1", amount: 3 },
            approval_state: "Rejected",
            document_type: "Purchase Order",
            subject_reference: null,
            amount_minor: 10,
            currency_code: "USD",
            current_step: 1,
          },
          {
            id: "n1",
            created_at: "2026-10-16T09:00:00Z",
            kind: "approval.requested",
            section: "Needs You",
            read_at: null,
            subject_table: "approval_instances",
            subject_id: "a1",
            project_id: "p",
            message_args: null,
            approval_state: "In Review",
            document_type: "Purchase Order",
            subject_reference: "PO-7",
            amount_minor: 40000,
            currency_code: "USD",
            current_step: 1,
          },
          {
            id: "n3",
            created_at: "2026-10-16T11:00:00Z",
            kind: "mention.created",
            section: "Needs You",
            read_at: null,
            subject_table: null,
            subject_id: null,
            project_id: null,
            message_args: [],
            approval_state: null,
          },
        ]),
      ],
      "rpc:act_on_notification": [ok("n1")],
      "from:notifications": [ok([{ id: "n3", created_at: "2026-10-16T11:00:00Z" }]), ok([])],
      "from:inbox_snoozes": [ok([{ id: "s1" }])],
    });
    const inbox = await listInbox(db, "o");
    expect(inbox.ok && inbox.data.map((i) => i.id)).toEqual(["n3", "n1", "n2"]);
    if (!inbox.ok) return;
    expect(inbox.data[1]?.approval).toMatchObject({
      instanceId: "a1",
      amountMinor: 40000,
      reference: "PO-7",
    });
    expect(inbox.data[2]?.args).toEqual({ title: "PO 1", amount: "3" });
    expect(inbox.data.map(isActionableApproval)).toEqual([false, true, false]);
    // A timesheet approval request (migration 1140) is approvable while it is in the Inbox.
    const timesheet = {
      ...(inbox.data[1] as NonNullable<(typeof inbox.data)[1]>),
      subjectTable: "timesheets",
      subjectId: "t1",
      approval: null,
    };
    expect(isActionableApproval(timesheet)).toBe(true);
    expect(isActionableApproval({ ...timesheet, kind: "mention.created" })).toBe(false);
    expect(await actOnInboxItem(db, { id: "n1", action: "approve" })).toEqual({
      ok: true,
      data: "n1",
    });
    expect(stepsOf(calls[1], "args")[0]).toEqual([
      { p_notification_id: "n1", p_action: "approve", p_comment: null },
    ]);
    expect(await snoozeInboxItem(db, { id: "n3", until: "2026-10-17T11:00:00Z" })).toEqual({
      ok: true,
      data: "s1",
    });
    const missing = await snoozeInboxItem(db, { id: "gone", until: "x" });
    expect(missing.ok === false && missing.error.kind).toBe("not-found");
    expect(snoozeUntil(new Date("2026-10-16T10:00:00Z"))).toBe("2026-10-17T10:00:00.000Z");
  });
});

describe("org lifecycle repository", () => {
  it("cancels, reads the cancellation, reactivates and checks export rights", async () => {
    const { db } = moduleClient({
      "rpc:cancel_organization": [ok("c1"), refused("org_name_mismatch")],
      "from:org_cancellations": [
        ok([
          {
            id: "c1",
            reason: "Done.",
            canceled_at: "2026-10-01T00:00:00Z",
            read_only_until: "2026-10-31T00:00:00Z",
            purge_after: "2026-12-30T00:00:00Z",
          },
        ]),
        ok([]),
      ],
      "rpc:reactivate_organization": [ok("c1")],
      "rpc:can_export_org": [ok(true)],
      "from:org_exports": [
        ok([{ id: "e1", created_at: "t", table_count: 2, row_count: 3, file_count: 1 }]),
      ],
    });
    expect(
      await cancelOrganization(db, { orgId: "o", confirmName: "Demo", reason: "Done." }),
    ).toEqual({ ok: true, data: "c1" });
    const wrong = await cancelOrganization(db, { orgId: "o", confirmName: "Dem", reason: "Done." });
    expect(wrong.ok === false && wrong.error.kind).toBe("refusal");
    const cancel = await getCancellation(db, "o");
    expect(cancel.ok && cancel.data?.readOnlyUntil).toBe("2026-10-31T00:00:00Z");
    expect(await getCancellation(db, "o")).toEqual({ ok: true, data: null });
    expect(await reactivateOrganization(db, "o")).toEqual({ ok: true, data: "c1" });
    expect(await canExportOrg(db, "o")).toEqual({ ok: true, data: true });
    expect(await listOrgExports(db, "o")).toEqual({
      ok: true,
      data: [{ id: "e1", createdAt: "t", tableCount: 2, rowCount: 3, fileCount: 1 }],
    });
    expect(daysUntil("2026-10-31T00:00:00Z", new Date("2026-10-16T12:00:00Z"))).toBe(15);
    expect(daysUntil("2026-10-01T00:00:00Z", new Date("2026-10-16T12:00:00Z"))).toBe(0);
  });

  it("writes CSV with quoting and JSON cells", () => {
    expect(
      toCsv(
        ["a", "b", "c"],
        [
          { a: 'say "hi"', b: { x: 1 }, c: null },
          { a: "1,2", b: 3 },
        ],
      ),
    ).toBe('a,b,c\r\n"say ""hi""","{""x"":1}",\r\n"1,2",3,\r\n');
    // A69-005: the archive's CSV never runs a cell as a formula; its JSON keeps the value exactly.
    expect(toCsv(["name", "n"], [{ name: "=1+1", n: -4 }])).toBe("name,n\r\n'=1+1,-4\r\n");
  });

  it("builds the archive from every readable table, the clean files and a manifest", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, org_id: "o" }));
    const base = moduleClient({
      "rpc:org_export_tables": [
        ok([
          { table_name: "venues", columns: ["id", "org_id", "name"] },
          { table_name: "audit_events", columns: ["org_id", "action"] },
          { table_name: "secret", columns: ["id"] },
        ]),
      ],
      "from:venues": [ok(page), ok([{ id: "last", org_id: "o", name: "Pier" }])],
      "from:audit_events": [ok([{ org_id: "o", action: "venue.insert" }])],
      "from:secret": [denied],
      "from:attachment_versions": [
        ok([
          {
            id: "av1",
            object_name: "o/a/1",
            filename: "Rider final.pdf",
            size_bytes: 4,
            checksum_sha256: "abc",
          },
          {
            id: "av2",
            object_name: "o/a/2",
            filename: "missing.pdf",
            size_bytes: 4,
            checksum_sha256: null,
          },
        ]),
      ],
      "rpc:record_org_export": [ok("e1")],
    });
    const storage = {
      from: () => ({
        async download(name: string) {
          return name === "o/a/1"
            ? { data: new Blob([new Uint8Array([1, 2, 3, 4])]), error: null }
            : { data: null, error: { message: "gone" } };
        },
      }),
    };
    const db = Object.assign(base.db, { storage }) as XosClient;
    const built = await buildOrgExport(
      db,
      { id: "o", slug: "demo" },
      new Date("2026-10-16T12:00:00Z"),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.data.rowCount).toBe(1002);
    expect(built.data.manifest.tables.map((t) => `${t.table}:${t.rows}`)).toEqual([
      "venues:1001",
      "audit_events:1",
    ]);
    expect(built.data.manifest.unreadableTables).toEqual(["secret"]);
    expect(built.data.manifest.files).toEqual([
      {
        path: "files/attachments/av1-Rider_final.pdf",
        bytes: 4,
        sha256: "abc",
        source: "attachments",
      },
    ]);
    expect(built.data.manifest.filesOmitted).toBe(1);
    expect(built.data.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new DataView(built.data.archive.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(await recordOrgExport(db, "o", built.data)).toEqual({ ok: true, data: "e1" });
    expect(
      (await listExportTables(moduleClient({ "rpc:org_export_tables": [denied] }).db, "o")).ok,
    ).toBe(false);
  });
});

describe("zip writer", () => {
  it("computes CRC-32 and writes readable headers", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const archive = zip(
      [{ name: "a.txt", data: new TextEncoder().encode("hi") }],
      new Date("2026-10-16T12:00:00Z"),
    );
    const view = new DataView(archive.buffer);
    expect(view.getUint32(archive.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(archive.length - 22 + 10, true)).toBe(1);
    expect(() =>
      zip(Array.from({ length: 65536 }, () => ({ name: "x", data: new Uint8Array() }))),
    ).toThrow(ZipLimitError);
  });
});
