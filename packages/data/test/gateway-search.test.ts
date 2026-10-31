import { describe, expect, it } from "vitest";
import {
  gatewaySearch,
  gatewaySearchHref,
  gatewaySearchRequest,
  hasGatewaySearchWords,
  type GatewaySearchHit,
} from "../src/gateway-search.ts";
import { toDisplayKey } from "../src/gateway-keys.ts";
import { parseSearchQuery } from "../src/search-query.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** A126 (RRR-171): the repository over app.gateway_search, the person's own Gateway search. */

const ENGAGEMENT = "01920000-0000-7000-8000-000000228401";
const THREAD = "01920000-0000-7000-8000-000000228501";

const row = {
  result_type: "document",
  result_id: "01920000-0000-7000-8000-000000228601",
  parent_id: ENGAGEMENT,
  kind: "Agreement",
  title: "Crew Agreement",
  detail: "Northwind Summer Series",
  org_id: "o1",
  org_name: "Northwind Live",
  dated_at: "2026-10-21T12:00:00Z",
  rank: 0.62,
};

describe("gatewaySearchRequest", () => {
  it("keeps the words, phrases and exclusions and drops Atlas's record operators", () => {
    const request = gatewaySearchRequest(
      parseSearchQuery('rigging "pier gate" -autumn status:open'),
    );
    expect(request).toEqual({
      terms: ["rigging"],
      phrases: ["pier gate"],
      exclude_terms: ["autumn"],
      exclude_phrases: [],
    });
    expect(gatewaySearchRequest(parseSearchQuery("rigging"), ["document"]).types).toEqual([
      "document",
    ]);
  });

  it("finds nothing without a word to look for", () => {
    expect(hasGatewaySearchWords(gatewaySearchRequest(parseSearchQuery("-autumn")))).toBe(false);
    expect(hasGatewaySearchWords(gatewaySearchRequest(parseSearchQuery("ri")))).toBe(true);
  });
});

describe("gatewaySearch", () => {
  it("sends the request and maps the rows, skipping rows it cannot place", async () => {
    const { db, calls } = fakeClient({
      "rpc:gateway_search": [
        okResponse([
          row,
          { ...row, result_type: "spaceship" },
          { ...row, result_id: null },
          { ...row, org_id: null },
        ]),
      ],
    });
    const request = gatewaySearchRequest(parseSearchQuery("crew agreement"));
    const result = await gatewaySearch(db, { request, orgId: "o1" });
    expect(result.ok && result.data).toEqual([
      {
        type: "document",
        id: row.result_id,
        parentId: ENGAGEMENT,
        kind: "Agreement",
        title: "Crew Agreement",
        detail: "Northwind Summer Series",
        orgId: "o1",
        orgName: "Northwind Live",
        datedAt: "2026-10-21T12:00:00Z",
        rank: 0.62,
      },
    ]);
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_query: request, p_org_id: "o1", p_limit: 6 }],
    ]);
  });

  it("leaves the org out on the platform domain and asks nothing for an empty query", async () => {
    const { db, calls } = fakeClient({ "rpc:gateway_search": [okResponse(null)] });
    const request = gatewaySearchRequest(parseSearchQuery("rigging"));
    expect(await gatewaySearch(db, { request, limit: 3 })).toEqual({ ok: true, data: [] });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_query: request, p_limit: 3 }]]);
    const empty = await gatewaySearch(db, { request: gatewaySearchRequest(parseSearchQuery("")) });
    expect(empty).toEqual({ ok: true, data: [] });
    expect(calls).toHaveLength(1);
  });

  it("returns the database's refusal", async () => {
    const { db } = fakeClient({
      "rpc:gateway_search": [errorResponse("permission denied", "42501")],
    });
    const result = await gatewaySearch(db, {
      request: gatewaySearchRequest(parseSearchQuery("rigging")),
    });
    expect(result.ok).toBe(false);
  });
});

describe("gatewaySearchHref", () => {
  const hit = (over: Partial<GatewaySearchHit>): GatewaySearchHit => ({
    type: "engagement",
    id: ENGAGEMENT,
    parentId: null,
    kind: null,
    title: null,
    detail: null,
    orgId: "o1",
    orgName: "",
    datedAt: null,
    rank: 1,
    ...over,
  });

  it("opens each result where Gateway shows it", () => {
    const key = toDisplayKey("engagement", ENGAGEMENT);
    expect(gatewaySearchHref(hit({}))).toBe(`/work/engagements/${key}/overview`);
    expect(
      gatewaySearchHref(hit({ type: "document", id: row.result_id, parentId: ENGAGEMENT })),
    ).toBe(`/work/engagements/${key}/documents`);
    expect(gatewaySearchHref(hit({ type: "document", parentId: null }))).toBeNull();
    expect(gatewaySearchHref(hit({ type: "message", id: THREAD }))).toBe(
      `/messages/${toDisplayKey("thread", THREAD)}`,
    );
    expect(gatewaySearchHref(hit({ type: "opportunity", id: THREAD }))).toBe(
      `/explore/${toDisplayKey("opportunity", THREAD)}`,
    );
  });
});
