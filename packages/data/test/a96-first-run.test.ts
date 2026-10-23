import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  amIPlatformStaff,
  feedbackRoute,
  feedbackScreenshotUrl,
  listFeedbackForTriage,
  sendFeedback,
  triageFeedback,
} from "../src/feedback.ts";
import {
  cleanProductEvents,
  isSessionKey,
  productAnalyticsAllowed,
  recordProductEvents,
  sendsGlobalPrivacyControl,
} from "../src/product-analytics.ts";
import { getMySandbox, openMySandbox, sandboxEnds } from "../src/sandbox.ts";
import {
  browserSubscription,
  registerWebPush,
  revokeWebPush,
  syncWebPush,
} from "../src/web-push.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** A96 (RRR-141): sandboxes (1530), feedback (1531), product analytics (1532) and browser push (1533). */

const SANDBOX = {
  org_id: "o1",
  slug: "sandbox-0a1b2c3d4e",
  name: "Northwind Live Sandbox",
  expires_at: "2026-11-04T12:00:00Z",
};

describe("sandboxes", () => {
  it("reads the person's sandbox, or none", async () => {
    const { db } = fakeClient({ "rpc:my_sandbox": [okResponse([SANDBOX]), okResponse([])] });
    expect(await getMySandbox(db)).toEqual({
      ok: true,
      data: {
        orgId: "o1",
        slug: "sandbox-0a1b2c3d4e",
        name: "Northwind Live Sandbox",
        expiresAt: "2026-11-04T12:00:00Z",
      },
    });
    expect(await getMySandbox(db)).toEqual({ ok: true, data: null });
  });

  it("opens one and passes the database's refusal through", async () => {
    const { db } = fakeClient({
      "rpc:open_my_sandbox": [
        okResponse([SANDBOX]),
        okResponse([]),
        errorResponse(
          "XR001",
          "sandbox_removing: Your last sandbox is still being removed. Try again in an hour.",
        ),
      ],
    });
    expect((await openMySandbox(db)).ok).toBe(true);
    expect(await openMySandbox(db)).toMatchObject({ ok: false, error: { kind: "unexpected" } });
    expect(await openMySandbox(db)).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "sandbox_removing" },
    });
  });

  it("says when an org is a sandbox and when it ends", async () => {
    const { db, calls } = fakeClient({
      "from:sandbox_orgs": [
        okResponse({ expires_at: "2026-11-04T12:00:00Z" }),
        okResponse(null),
        errorResponse("500", "down"),
      ],
    });
    expect(await sandboxEnds(db, "o1")).toEqual({ ok: true, data: "2026-11-04T12:00:00Z" });
    expect(await sandboxEnds(db, "o2")).toEqual({ ok: true, data: null });
    expect((await sandboxEnds(db, "o3")).ok).toBe(false);
    expect(calls[0]?.steps).toContainEqual(["eq", ["org_id", "o1"]]);
  });
});

describe("feedback", () => {
  it("sends only the path of the page, never its query string", () => {
    expect(feedbackRoute("/northwind/projects?view=board#top")).toBe("/northwind/projects");
    expect(feedbackRoute("not a path")).toBeNull();
    expect(feedbackRoute(`/${"a".repeat(600)}`)).toBeNull();
  });

  it("sends feedback with what the widget showed", async () => {
    const { db, calls } = fakeClient({
      "rpc:send_feedback": [
        okResponse("FB-000007"),
        errorResponse("XR001", "feedback_limit: Too many."),
      ],
    });
    const input = {
      app: "Atlas" as const,
      message: "Bulk edit, please.",
      route: "/northwind/projects",
      orgId: "o1",
      appVersion: "4.0.0",
      locale: "en-US",
      viewport: "1280x720",
      screenshotPath: null,
    };
    expect(await sendFeedback(db, input)).toEqual({ ok: true, data: "FB-000007" });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({
      p_app_code: "Atlas",
      p_message: "Bulk edit, please.",
      p_route: "/northwind/projects",
      p_org_id: "o1",
      p_app_version: "4.0.0",
      p_locale: "en-US",
      p_viewport: "1280x720",
    });
    expect(
      await sendFeedback(db, {
        ...input,
        route: null,
        orgId: null,
        appVersion: null,
        locale: null,
        viewport: null,
      }),
    ).toMatchObject({
      ok: false,
      error: { rule: "feedback_limit" },
    });
  });

  it("lists and triages feedback for platform staff", async () => {
    const row = {
      id: "f1",
      submission_number: "FB-000001",
      app_code: "Gateway",
      message: "Hard to find pay.",
      route: "/money",
      app_version: null,
      locale: "en-US",
      viewport: "390x844",
      context_org_slug: null,
      sender_name: "Nina Halvorsen",
      screenshot_path: "p/shot.png",
      screenshot_scan: "Clean",
      triage_state: "New",
      triage_note: null,
      triaged_at: null,
      created_at: "2026-10-21T10:00:00Z",
    };
    const { db, calls } = fakeClient({
      "rpc:am_i_platform_staff": [okResponse(true), errorResponse("500", "down")],
      "rpc:feedback_triage_list": [
        okResponse([row]),
        errorResponse("42501", "platform staff only"),
      ],
      "rpc:triage_feedback": [
        okResponse(null),
        errorResponse("XR001", "feedback_state_unknown: No."),
      ],
    });
    expect(await amIPlatformStaff(db)).toEqual({ ok: true, data: true });
    expect((await amIPlatformStaff(db)).ok).toBe(false);
    const listed = await listFeedbackForTriage(db, "New");
    expect(listed.ok && listed.data[0]).toMatchObject({
      number: "FB-000001",
      app: "Gateway",
      senderName: "Nina Halvorsen",
      screenshotScan: "Clean",
    });
    expect(calls.find((c) => c.target === "rpc:feedback_triage_list")?.steps[0]?.[1][0]).toEqual({
      p_state: "New",
    });
    expect(await listFeedbackForTriage(db)).toMatchObject({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(await triageFeedback(db, { id: "f1", state: "Planned", note: "Next sprint." })).toEqual({
      ok: true,
      data: null,
    });
    expect(await triageFeedback(db, { id: "f1", state: "Closed", note: null })).toMatchObject({
      ok: false,
    });
  });

  it("opens a screenshot through a short signed link", async () => {
    const storage = (signed: string | null) =>
      ({
        storage: {
          from: () => ({
            createSignedUrl: async () =>
              signed
                ? { data: { signedUrl: signed }, error: null }
                : { data: null, error: { message: "denied" } },
          }),
        },
      }) as unknown as XosClient;
    expect(await feedbackScreenshotUrl(storage("https://db.example.test/s"), "p/shot.png")).toEqual(
      { ok: true, data: "https://db.example.test/s" },
    );
    expect(await feedbackScreenshotUrl(storage(null), "p/shot.png")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});

describe("product analytics", () => {
  it("records nothing without a yes to performance cookies, and nothing with Global Privacy Control", () => {
    expect(productAnalyticsAllowed({ performance: null, gpc: false })).toBe(false);
    expect(productAnalyticsAllowed({ performance: false, gpc: false })).toBe(false);
    expect(productAnalyticsAllowed({ performance: true, gpc: true })).toBe(false);
    expect(productAnalyticsAllowed({ performance: true, gpc: false })).toBe(true);
  });

  it("reads the Sec-GPC header", () => {
    expect(sendsGlobalPrivacyControl(new Headers({ "Sec-GPC": "1" }))).toBe(true);
    expect(sendsGlobalPrivacyControl(new Headers())).toBe(false);
  });

  it("keeps only well-formed events with no path, person or free text", () => {
    const at = "2026-10-21T10:00:00.000Z";
    expect(
      cleanProductEvents([
        { occurredAt: at, name: "Page Viewed", route: "/[org]/projects" },
        { occurredAt: at, name: "Page Viewed", route: "/northwind/projects?x=1" },
        {
          occurredAt: at,
          name: "Workflow Started",
          workflow: "atlas.projects_gates",
          email: "a@b.c",
        },
        { occurredAt: at, name: "Workflow Step", workflow: "atlas.projects_gates", step: 2 },
        { occurredAt: at, name: "Workflow Step", workflow: "atlas.projects_gates" },
        { occurredAt: at, name: "Clicked", route: "/home" },
        { occurredAt: "yesterday", name: "Page Viewed", route: "/home" },
        "junk",
      ]),
    ).toEqual([
      { occurredAt: at, name: "Page Viewed", route: "/[org]/projects" },
      { occurredAt: at, name: "Workflow Started", workflow: "atlas.projects_gates" },
      { occurredAt: at, name: "Workflow Step", workflow: "atlas.projects_gates", step: 2 },
    ]);
    expect(cleanProductEvents("nope")).toEqual([]);
    expect(
      cleanProductEvents(
        Array.from({ length: 40 }, () => ({ occurredAt: at, name: "Page Viewed", route: "/home" })),
      ),
    ).toHaveLength(25);
  });

  it("accepts only a random session key", () => {
    expect(isSessionKey("6f1c3a52-0d1e-4b8e-9a4f-1d2c3b4a5e6f")).toBe(true);
    expect(isSessionKey("person-1")).toBe(false);
  });

  it("records a consented batch", async () => {
    const { db, calls } = fakeClient({
      "rpc:record_product_events": [
        okResponse(1),
        errorResponse("XR001", "product_events_limit: Too many."),
      ],
    });
    const events = [
      { occurredAt: "2026-10-21T10:00:00Z", name: "Page Viewed" as const, route: "/home" },
    ];
    expect(await recordProductEvents(db, { app: "Gateway", sessionKey: "k", events: [] })).toEqual({
      ok: true,
      data: 0,
    });
    expect(await recordProductEvents(db, { app: "Gateway", sessionKey: "k", events })).toEqual({
      ok: true,
      data: 1,
    });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({
      p_app_code: "Gateway",
      p_session_key: "k",
      p_events: events,
    });
    expect((await recordProductEvents(db, { app: "Gateway", sessionKey: "k", events })).ok).toBe(
      false,
    );
  });
});

describe("browser push", () => {
  const json = {
    endpoint: "https://push.example.test/send/abc",
    keys: { p256dh: `B${"q".repeat(86)}`, auth: "a".repeat(22) },
  };

  it("parses PushSubscription.toJSON() and refuses anything malformed", () => {
    expect(browserSubscription(json)).toEqual({
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    });
    expect(browserSubscription({ ...json, endpoint: "http://push.example.test/x" })).toBeNull();
    expect(
      browserSubscription({ ...json, keys: { p256dh: "short", auth: json.keys.auth } }),
    ).toBeNull();
    expect(browserSubscription({ ...json, keys: { p256dh: json.keys.p256dh } })).toBeNull();
    expect(browserSubscription(null)).toBeNull();
  });

  it("registers, syncs and revokes through the 1533 RPCs", async () => {
    const sub = browserSubscription(json);
    if (!sub) throw new Error("expected a subscription");
    const { db, calls } = fakeClient({
      "rpc:register_web_push": [okResponse(2), errorResponse("XR001", "web_push_invalid: No.")],
      "rpc:sync_web_push": [
        okResponse("active"),
        okResponse("unknown"),
        errorResponse("500", "down"),
      ],
      "rpc:revoke_web_push": [okResponse(2), errorResponse("500", "down")],
    });
    expect(await registerWebPush(db, "Atlas", sub)).toEqual({ ok: true, data: 2 });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({
      p_app: "Atlas",
      p_endpoint: sub.endpoint,
      p_p256dh: sub.p256dh,
      p_auth: sub.auth,
    });
    expect((await registerWebPush(db, "Atlas", sub)).ok).toBe(false);
    expect(await syncWebPush(db, "Gateway", sub)).toEqual({ ok: true, data: "active" });
    expect(await syncWebPush(db, "Gateway", sub)).toEqual({ ok: true, data: "unknown" });
    expect((await syncWebPush(db, "Gateway", sub)).ok).toBe(false);
    expect(await revokeWebPush(db, sub.endpoint)).toEqual({ ok: true, data: 2 });
    expect((await revokeWebPush(db, sub.endpoint)).ok).toBe(false);
  });
});
