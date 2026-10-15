/**
 * A04P contract tests for the Platform handlers. Requests run through `contractApp` against the
 * in-memory client; every response is checked against openapi/v1.json with `expectContract`.
 */
import { describe, expect, it } from "vitest";
import { handlers } from "../src/handlers/platform.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";
import { sample } from "./support/samples.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const TIMES = {
  created_at: "2026-10-01T12:00:00.000Z",
  created_by: null,
  updated_at: "2026-10-01T12:00:00.000Z",
  updated_by: null,
};
const TYPE = id(2001);
const RECORD = id(2002);
const THREAD = id(2010);

function seed(component: string, rowId: string, extra: Row = {}): Row {
  return { ...sample(component, { id: rowId, ...TIMES, org_id: ORG, ...extra }), deleted_at: null };
}

function world() {
  const db = memoryDb(
    {
      custom_object_types: [seed("CustomObjectType", TYPE, { object_key: "trucks" })],
      custom_object_fields: [
        seed("CustomObjectField", id(2003), {
          custom_object_type_id: TYPE,
          field_key: "plate",
          data_type: "Text",
        }),
        seed("CustomObjectField", id(2004), {
          custom_object_type_id: TYPE,
          field_key: "axles",
          data_type: "Number",
        }),
        seed("CustomObjectField", id(2005), {
          custom_object_type_id: TYPE,
          field_key: "rate",
          data_type: "Money",
        }),
      ],
      custom_object_records: [
        {
          id: RECORD,
          org_id: ORG,
          ...TIMES,
          custom_object_type_id: TYPE,
          title: "Truck 7",
          deleted_at: null,
        },
      ],
      custom_object_values: [
        {
          id: id(2006),
          custom_object_record_id: RECORD,
          custom_object_field_id: id(2003),
          value_text: "FL-7788",
          value_number: null,
          deleted_at: null,
        },
      ],
      custom_object_relations: [seed("CustomObjectRelation", id(2007))],
      custom_field_definitions: [seed("CustomFieldDefinition", id(2008))],
      custom_field_values: [seed("CustomFieldValue", id(2009))],
      import_jobs: [seed("ImportJob", id(2020))],
      import_batches: [seed("ImportBatch", id(2021), { undone_at: null })],
      import_row_results: [seed("ImportRowResult", id(2022))],
      import_mapping_profiles: [seed("ImportMappingProfile", id(2023))],
      merge_reviews: [seed("MergeReview", id(2024), { decision: null })],
      export_jobs: [seed("ExportJob", id(2025))],
      saved_views: [seed("SavedView", id(2026))],
      comment_threads: [
        seed("CommentThread", THREAD, {
          subject_table: "records",
          anchor: null,
          resolved_at: null,
        }),
      ],
      comments: [seed("Comment", id(2011), { comment_thread_id: THREAD, author_person_id: ME })],
      notifications: [seed("Notification", id(2030), { recipient_person_id: ME, read_at: null })],
      notification_preferences: [seed("NotificationPreference", id(2031))],
      calendar_feeds: [seed("CalendarFeed", id(2032), { revoked_at: null })],
    },
    {
      undo_import_batch: (args, self) => {
        const batch = self.tables["import_batches"]?.find(
          (b) => b["id"] === args["p_import_batch_id"],
        );
        if (batch) {
          batch["undone_at"] = "2026-10-02T09:00:00.000Z";
          batch["undo_reason"] = args["p_reason"];
        }
        return [{ kept: 0, reverted: 3 }];
      },
      request_export: (args, self) => {
        self.tables["export_jobs"]?.push(
          seed("ExportJob", id(2040), {
            source_label: args["p_source_label"],
            export_format: args["p_format"],
          }),
        );
        return id(2040);
      },
      post_comment: (args, self) => {
        self.tables["comments"]?.push(
          seed("Comment", id(2041), {
            comment_thread_id: THREAD,
            body: args["p_body"],
            author_person_id: ME,
          }),
        );
        return id(2041);
      },
      mark_notifications_read: () => 4,
      create_calendar_feed: () => [
        { calendar_feed_id: id(2042), feed_token: "cal_9fQ2mX4vT7kL1pR8" },
      ],
    },
    {
      custom_object_types: { default_view: "Table" },
      custom_object_fields: { required: false, filterable: false },
      custom_field_definitions: { required: false, filterable: false },
      custom_object_relations: { org_id: ORG },
      custom_field_values: { org_id: ORG },
      import_jobs: { import_status: "Uploaded", mapping_confirmed_at: null },
      saved_views: { org_id: ORG, shared: false },
      comment_threads: { resolved_at: null, resolved_by: null },
      notification_preferences: { org_id: ORG },
    },
  );
  const app = contractApp({ handlers: [handlers], db });
  return { db, http: requests(app) };
}

describe("custom objects", () => {
  it("serves types, fields, relations and custom fields", async () => {
    const { http } = world();
    const types = await http.get("/custom-object-types");
    await expectContract(await success(types), "customObjectTypes.list");
    const type = await http.get(`/custom-object-types/${TYPE}`);
    await expectContract(await success(type), "customObjectTypes.get");
    const madeType = await http.post("/custom-object-types", {
      object_key: "cases",
      label: "Cases",
      icon: "box",
    });
    await expectContract(await success(madeType), "customObjectTypes.create");
    const editedType = await http.patch(`/custom-object-types/${TYPE}`, { label: "Trucks" });
    await expectContract(await success(editedType), "customObjectTypes.update");

    const fields = await http.get("/custom-object-fields");
    await expectContract(await success(fields), "customObjectFields.list");
    const field = await http.get(`/custom-object-fields/${id(2003)}`);
    await expectContract(await success(field), "customObjectFields.get");
    const madeField = await http.post("/custom-object-fields", {
      custom_object_type_id: TYPE,
      field_key: "driver",
      label: "Driver",
      data_type: "Person",
      sort_order: 4,
    });
    await expectContract(await success(madeField), "customObjectFields.create");
    const editedField = await http.patch(`/custom-object-fields/${id(2003)}`, { label: "Plate" });
    await expectContract(await success(editedField), "customObjectFields.update");
    const removedField = await http.delete(`/custom-object-fields/${id(2005)}`);
    await expectContract(await success(removedField), "customObjectFields.delete");

    const relations = await http.get("/custom-object-relations");
    await expectContract(await success(relations), "customObjectRelations.list");
    const relation = await http.get(`/custom-object-relations/${id(2007)}`);
    await expectContract(await success(relation), "customObjectRelations.get");
    const madeRelation = await http.post("/custom-object-relations", {
      from_record_id: RECORD,
      relation_key: "assigned_project",
      to_project_id: id(2050),
    });
    await expectContract(await success(madeRelation), "customObjectRelations.create");
    const removedRelation = await http.delete(`/custom-object-relations/${id(2007)}`);
    await expectContract(await success(removedRelation), "customObjectRelations.delete");

    const definitions = await http.get("/custom-field-definitions");
    await expectContract(await success(definitions), "customFieldDefinitions.list");
    const definition = await http.get(`/custom-field-definitions/${id(2008)}`);
    await expectContract(await success(definition), "customFieldDefinitions.get");
    const madeDefinition = await http.post(
      "/custom-field-definitions",
      sample("CustomFieldDefinitionCreate"),
    );
    await expectContract(await success(madeDefinition), "customFieldDefinitions.create");
    const editedDefinition = await http.patch(`/custom-field-definitions/${id(2008)}`, {
      label: "PO",
    });
    await expectContract(await success(editedDefinition), "customFieldDefinitions.update");
    const removedDefinition = await http.delete(`/custom-field-definitions/${id(2008)}`);
    await expectContract(await success(removedDefinition), "customFieldDefinitions.delete");

    const values = await http.get("/custom-field-values");
    await expectContract(await success(values), "customFieldValues.list");
    const value = await http.get(`/custom-field-values/${id(2009)}`);
    await expectContract(await success(value), "customFieldValues.get");
    const madeValue = await http.post("/custom-field-values", {
      custom_field_definition_id: id(2008),
      target_id: id(2051),
      value_text: "PO-4410",
    });
    await expectContract(await success(madeValue), "customFieldValues.create");
    const editedValue = await http.patch(`/custom-field-values/${id(2009)}`, {
      value_text: "PO-4411",
    });
    await expectContract(await success(editedValue), "customFieldValues.update");
    const removedValue = await http.delete(`/custom-field-values/${id(2009)}`);
    await expectContract(await success(removedValue), "customFieldValues.delete");

    const removedType = await http.delete(`/custom-object-types/${TYPE}`);
    await expectContract(await success(removedType), "customObjectTypes.delete");
  });

  it("serves records with their typed values", async () => {
    const { db, http } = world();
    const listed = await http.get("/objects/trucks");
    const page = (await expectContract(await success(listed), "objects.list")) as { data: Row[] };
    expect(page.data[0]?.["values"]).toEqual({ plate: "FL-7788", axles: null, rate: null });
    const read = await http.get(`/objects/trucks/${RECORD}`);
    await expectContract(await success(read), "objects.get");
    const made = await http.post("/objects/trucks", {
      title: "Truck 9",
      values: { plate: "FL-9900", axles: 3 },
    });
    const record = (await expectContract(await success(made), "objects.create")) as Row;
    expect(record["values"]).toMatchObject({ plate: "FL-9900", axles: 3 });
    const edited = await http.patch(`/objects/trucks/${RECORD}`, {
      title: "Truck Seven",
      values: { plate: "FL-7789" },
    });
    const after = (await expectContract(await success(edited), "objects.update")) as Row;
    expect(after["values"]).toMatchObject({ plate: "FL-7789" });
    const money = await http.patch(`/objects/trucks/${RECORD}`, { values: { rate: 120000 } });
    expect(money.status).toBe(422);
    const unknown = await http.patch(`/objects/trucks/${RECORD}`, { values: { color: "red" } });
    expect(unknown.status).toBe(422);
    const otherType = await http.get(`/objects/cases/${RECORD}`);
    expect(otherType.status).toBe(404);
    const removed = await http.delete(`/objects/trucks/${RECORD}`);
    await expectContract(await success(removed), "objects.delete");
    expect(db.writes.filter((w) => w.table === "custom_object_values")).toHaveLength(3);
  });
});

describe("imports, merges and exports", () => {
  it("serves import jobs, batches, row results and mapping profiles", async () => {
    const { http } = world();
    const jobs = await http.get("/import-jobs");
    await expectContract(await success(jobs), "importJobs.list");
    const job = await http.get(`/import-jobs/${id(2020)}`);
    await expectContract(await success(job), "importJobs.get");
    const madeJob = await http.post(
      "/import-jobs",
      sample("ImportJobCreate", { import_mapping_profile_id: null }),
    );
    await expectContract(await success(madeJob), "importJobs.create");

    const batches = await http.get("/import-batches");
    await expectContract(await success(batches), "importBatches.list");
    const batch = await http.get(`/import-batches/${id(2021)}`);
    await expectContract(await success(batch), "importBatches.get");
    const undone = await http.post(`/import-batches/${id(2021)}/undo`);
    const after = (await expectContract(await success(undone), "importBatches.undo")) as Row;
    expect(after["undone_at"]).not.toBeNull();

    const rows = await http.get("/import-row-results");
    await expectContract(await success(rows), "importRowResults.list");
    const row = await http.get(`/import-row-results/${id(2022)}`);
    await expectContract(await success(row), "importRowResults.get");

    const profiles = await http.get("/import-mapping-profiles");
    await expectContract(await success(profiles), "importMappingProfiles.list");
    const profile = await http.get(`/import-mapping-profiles/${id(2023)}`);
    await expectContract(await success(profile), "importMappingProfiles.get");
    const madeProfile = await http.post("/import-mapping-profiles", {
      name: "Vendors",
      target_code: "vendors",
    });
    await expectContract(await success(madeProfile), "importMappingProfiles.create");
    const editedProfile = await http.patch(`/import-mapping-profiles/${id(2023)}`, {
      name: "Vendors 2026",
    });
    await expectContract(await success(editedProfile), "importMappingProfiles.update");
    const removedProfile = await http.delete(`/import-mapping-profiles/${id(2023)}`);
    await expectContract(await success(removedProfile), "importMappingProfiles.delete");
  });

  it("serves merge reviews and exports", async () => {
    const { db, http } = world();
    const reviews = await http.get("/merge-reviews");
    await expectContract(await success(reviews), "mergeReviews.list");
    const review = await http.get(`/merge-reviews/${id(2024)}`);
    await expectContract(await success(review), "mergeReviews.get");
    const decided = await http.patch(`/merge-reviews/${id(2024)}`, { decision: "Merge" });
    await expectContract(await success(decided), "mergeReviews.update");

    const exports = await http.get("/export-jobs");
    await expectContract(await success(exports), "exportJobs.list");
    const exportJob = await http.get(`/export-jobs/${id(2025)}`);
    await expectContract(await success(exportJob), "exportJobs.get");
    const requested = await http.post("/export-jobs", {
      source_label: "Vendors",
      export_format: "CSV",
      columns: ["app.vendors.name"],
    });
    await expectContract(await success(requested), "exportJobs.create");
    expect(db.calls.find((c) => c.name === "request_export")?.args["p_columns"]).toEqual([
      "app.vendors.name",
    ]);
    db.fail("rpc:request_export", refusal("export_restricted"));
    const refused = await http.post("/export-jobs", {
      source_label: "Tax",
      export_format: "CSV",
      columns: ["app.tax_forms.tin_last4"],
    });
    expect(refused.status).toBe(422);
  });

  it("serves saved views", async () => {
    const { http } = world();
    const listed = await http.get("/saved-views");
    await expectContract(await success(listed), "savedViews.list");
    const read = await http.get(`/saved-views/${id(2026)}`);
    await expectContract(await success(read), "savedViews.get");
    const made = await http.post("/saved-views", sample("SavedViewCreate"));
    await expectContract(await success(made), "savedViews.create");
    const edited = await http.patch(`/saved-views/${id(2026)}`, { name: "My Open Records" });
    await expectContract(await success(edited), "savedViews.update");
    const removed = await http.delete(`/saved-views/${id(2026)}`);
    await expectContract(await success(removed), "savedViews.delete");
  });
});

describe("comments", () => {
  it("serves threads and comments through app.post_comment", async () => {
    const { db, http } = world();
    const threads = await http.get("/comment-threads");
    await expectContract(await success(threads), "commentThreads.list");
    const thread = await http.get(`/comment-threads/${THREAD}`);
    await expectContract(await success(thread), "commentThreads.get");
    const opened = await http.post("/comment-threads", {
      subject_table: "records",
      subject_id: id(2052),
    });
    await expectContract(await success(opened), "commentThreads.create");
    const resolved = await http.patch(`/comment-threads/${THREAD}`, {
      resolved_at: "2026-10-02T09:00:00Z",
      anchor: "para-2",
    });
    const after = (await expectContract(await success(resolved), "commentThreads.update")) as Row;
    expect(after["resolved_at"]).not.toBeNull();

    const listed = await http.get(`/comments?filter[comment_thread_id][eq]=${THREAD}`);
    await expectContract(await success(listed), "comments.list");
    const read = await http.get(`/comments/${id(2011)}`);
    await expectContract(await success(read), "comments.get");
    const posted = await http.post("/comments", {
      comment_thread_id: THREAD,
      body: "Truss is in.",
    });
    await expectContract(await success(posted), "comments.create");
    expect(db.calls.find((c) => c.name === "post_comment")?.args).toMatchObject({
      p_subject_table: "records",
      p_body: "Truss is in.",
    });
    const edited = await http.patch(`/comments/${id(2011)}`, { body: "Truss is in and rigged." });
    await expectContract(await success(edited), "comments.update");
    const removed = await http.delete(`/comments/${id(2011)}`);
    await expectContract(await success(removed), "comments.delete");
  });
});

describe("notifications and calendar feeds", () => {
  it("serves notifications and preferences", async () => {
    const { http } = world();
    const listed = await http.get("/notifications");
    await expectContract(await success(listed), "notifications.list");
    const read = await http.get(`/notifications/${id(2030)}`);
    await expectContract(await success(read), "notifications.get");
    const marked = await http.patch(`/notifications/${id(2030)}`, {
      read_at: "2026-10-02T09:00:00Z",
    });
    await expectContract(await success(marked), "notifications.update");
    const all = await http.post("/notifications/mark-all-read");
    const result = (await expectContract(await success(all), "notifications.markAllRead")) as Row;
    expect(result["updated_count"]).toBe(4);

    const prefs = await http.get("/notification-preferences");
    await expectContract(await success(prefs), "notificationPreferences.list");
    const pref = await http.get(`/notification-preferences/${id(2031)}`);
    await expectContract(await success(pref), "notificationPreferences.get");
    const madePref = await http.post(
      "/notification-preferences",
      sample("NotificationPreferenceCreate"),
    );
    await expectContract(await success(madePref), "notificationPreferences.create");
    const editedPref = await http.patch(`/notification-preferences/${id(2031)}`, {
      enabled: false,
    });
    await expectContract(await success(editedPref), "notificationPreferences.update");
  });

  it("creates a feed with its token once and revokes it", async () => {
    const { db, http } = world();
    const listed = await http.get("/calendar-feeds");
    await expectContract(await success(listed), "calendarFeeds.list");
    const read = await http.get(`/calendar-feeds/${id(2032)}`);
    await expectContract(await success(read), "calendarFeeds.get");
    const made = await http.post("/calendar-feeds", { project_id: id(2053) });
    const feed = (await expectContract(await success(made), "calendarFeeds.create")) as Row;
    expect(feed["feed_token"]).toMatch(/^cal_/);
    const revoked = await http.delete(`/calendar-feeds/${id(2032)}`);
    await expectContract(await success(revoked), "calendarFeeds.delete");
    expect(db.writes.at(-1)?.values).toHaveProperty("revoked_at");
  });
});
