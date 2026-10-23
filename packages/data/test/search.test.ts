import { describe, expect, it } from "vitest";
import { globalSearch, recentItems, recordRecentView, searchContext } from "../src/search.ts";
import { parseSearchQuery, searchRequest } from "../src/search-query.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** A87 (RRR-132, finding A65-005): the repository over app.global_search and the recent views. */

const hitRow = {
  result_type: "record",
  result_id: "r1",
  result_key: "NWL-12",
  title: "Hang the main truss",
  record_kind: "Task",
  state: "Scheduled",
  project_key: "NWL",
  dated_at: "2026-10-21T12:00:00Z",
  rank: 0.71,
  matched: "text",
};

describe("globalSearch", () => {
  it("sends the structured request and maps the rows", async () => {
    const { db, calls } = fakeClient({
      "rpc:global_search": [
        okResponse([
          hitRow,
          {
            ...hitRow,
            result_type: "person",
            result_id: "p1",
            result_key: null,
            record_kind: null,
            matched: "odd",
          },
          { result_type: "spaceship", result_id: "x" },
          { result_type: "record", result_id: null },
        ]),
      ],
    });
    const request = searchRequest(parseSearchQuery('"main truss" status:open'));
    const result = await globalSearch(db, { orgId: "o1", request });
    expect(result.ok && result.data).toEqual([
      {
        type: "record",
        id: "r1",
        key: "NWL-12",
        title: "Hang the main truss",
        recordKind: "Task",
        state: "Scheduled",
        projectKey: "NWL",
        datedAt: "2026-10-21T12:00:00Z",
        rank: 0.71,
        matched: "text",
      },
      {
        type: "person",
        id: "p1",
        key: null,
        title: "Hang the main truss",
        recordKind: null,
        state: "Scheduled",
        projectKey: "NWL",
        datedAt: "2026-10-21T12:00:00Z",
        rank: 0.71,
        matched: "text",
      },
    ]);
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "o1", p_query: request, p_embedding: null, p_limit: 8, p_min_similarity: 0.35 }],
    ]);
  });

  it("passes the query vector and its model", async () => {
    const { db, calls } = fakeClient({ "rpc:global_search": [okResponse(null)] });
    const request = searchRequest(parseSearchQuery("harness"));
    const result = await globalSearch(db, {
      orgId: "o1",
      request,
      embedding: "[0.1,0.2]",
      model: "local-hash-384",
      limit: 20,
      minSimilarity: 0.25,
    });
    expect(result).toEqual({ ok: true, data: [] });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_org_id: "o1",
          p_query: { ...request, model: "local-hash-384" },
          p_embedding: "[0.1,0.2]",
          p_limit: 20,
          p_min_similarity: 0.25,
        },
      ],
    ]);
  });

  it("turns a refusal into a typed error", async () => {
    const { db } = fakeClient({
      "rpc:global_search": [
        errorResponse(
          "XR001",
          "search_date_invalid: A search date is not a calendar date.",
          "search_date_invalid",
        ),
      ],
    });
    const result = await globalSearch(db, {
      orgId: "o1",
      request: searchRequest(parseSearchQuery("x")),
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "refusal",
        rule: "search_date_invalid",
        message: "A search date is not a calendar date.",
      },
    });
  });
});

describe("recent views", () => {
  it("lists recent items and skips rows it cannot place", async () => {
    const { db, calls } = fakeClient({
      "rpc:recent_items": [
        okResponse([
          {
            result_type: "incident",
            result_id: "i1",
            result_key: "NWL-3",
            title: "Truss Failure",
            record_kind: null,
            state: "Reported",
            project_key: "NWL",
            viewed_at: "2026-10-21T12:00:00Z",
          },
          { result_type: "person", result_id: "p1", viewed_at: "2026-10-21T12:00:00Z" },
          { result_type: "sop", result_id: "s1", viewed_at: null },
        ]),
      ],
    });
    const result = await recentItems(db, "o1", 10);
    expect(result.ok && result.data).toEqual([
      {
        type: "incident",
        id: "i1",
        key: "NWL-3",
        title: "Truss Failure",
        recordKind: null,
        state: "Reported",
        projectKey: "NWL",
        viewedAt: "2026-10-21T12:00:00Z",
      },
    ]);
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_org_id: "o1", p_limit: 10 }]]);
  });

  it("reports a failed read", async () => {
    const { db } = fakeClient({ "rpc:recent_items": [errorResponse("42501", "not a member")] });
    expect((await recentItems(db, "o1")).ok).toBe(false);
  });

  it("records a view, and never throws when it cannot", async () => {
    const { db, calls } = fakeClient({
      "rpc:record_recent_view": [okResponse(true), okResponse(false), errorResponse("42501", "no")],
    });
    expect(await recordRecentView(db, { orgId: "o1", table: "records", id: "r1" })).toBe(true);
    expect(await recordRecentView(db, { orgId: "o1", table: "sops", id: "s1" })).toBe(false);
    expect(await recordRecentView(db, { orgId: "o1", table: "sops", id: "s1" })).toBe(false);
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "o1", p_subject_table: "records", p_subject_id: "r1" }],
    ]);
    const broken = fakeClient({});
    expect(await recordRecentView(broken.db, { orgId: "o1", table: "records", id: "r1" })).toBe(
      false,
    );
  });
});

describe("searchContext", () => {
  it("reads the person, the org's calendar and the semantic switch", async () => {
    const { db } = fakeClient({
      "rpc:search_context": [
        okResponse([
          {
            person_id: "p1",
            time_zone: "America/New_York",
            org_today: "2026-10-21",
            semantic_enabled: true,
          },
        ]),
        okResponse([]),
        errorResponse("42501", "only an active member of the org can do this"),
      ],
    });
    expect(await searchContext(db, "o1")).toEqual({
      ok: true,
      data: {
        personId: "p1",
        timeZone: "America/New_York",
        today: "2026-10-21",
        semanticEnabled: true,
      },
    });
    expect(await searchContext(db, "o1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await searchContext(db, "o1")).ok).toBe(false);
  });
});
